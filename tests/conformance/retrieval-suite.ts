// tests/conformance/retrieval-suite.ts — 检索层准入契约 (ADR-020 的检索侧)。
//
// 存储侧契约保证"存得对、取得回"; 检索侧契约保证"找得到、排得对、预算得住、治理不破"。
// 任何检索实现 (HybridRetriever + 任意 source + 任意向量索引) 都要跑通同一份。
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { HybridRetriever } from "../../src/retrieval/hybrid.ts";
import { LinearVectorIndex } from "../../src/retrieval/vector.ts";
import type { MemoryEntry, MemoryEntryInput, Query } from "../../src/kernel/types.ts";
import type { RetrievalSource, SyncEmbedder } from "../../src/kernel/ports.ts";

export interface RetrievalHarness {
  /** 既是检索源, 也能写入 (存储实现天然满足)。 */
  source: RetrievalSource & { add(entry: MemoryEntryInput): MemoryEntry | Promise<MemoryEntry> };
  /** 可选: 持久化实现用来验证"重建后检索行为一致"。 */
  rebuild?(): Promise<void> | void;
  reopen?(): Promise<void> | void;
  dispose?(): Promise<void> | void;
}

export interface RetrievalSpec {
  name: string;
  create(): Promise<RetrievalHarness> | RetrievalHarness;
  /** 是否启用向量通道 (默认启用, 用桩嵌入器)。 */
  vector?: boolean;
}

const T = { validAt: "2026-06-01T00:00:00.000Z", assertedAt: "2026-06-01T00:00:00.000Z" };

function entry(over: Partial<MemoryEntryInput>): MemoryEntryInput {
  return {
    kind: "lesson",
    content: "容器并发要显式设上限",
    source: "session:conformance",
    scope: "agent",
    ts: T,
    ...over,
  };
}

/**
 * 桩嵌入器: 模拟真模型的"同义/话题"能力 —— 部署类映射到 e1, 工程类映射到 e2, 其它正交。
 * 关键点: 与语料无关的文本必须落到正交方向, 否则"无关查询不返回东西"这条契约就没法验 (真实的
 * 退化嵌入器也会造成同样的问题 —— 这也是为什么向量通道必须有 floor 与 conformance)。
 */
const stubEmbedder: SyncEmbedder = {
  id: "stub-embed",
  dim: 3,
  embedSync(texts) {
    return texts.map((t) => {
      if (/部署|上线|发布|release|deploy/i.test(t)) return [1, 0, 0];
      if (/并发|容器|连接池|pnpm|数据库|monorepo|校验/i.test(t)) return [0, 1, 0];
      return [0, 0, 1];
    });
  },
  embed(texts) {
    return this.embedSync(texts);
  },
};

/** 固定语料: 查询与期望命中的黄金集 (引擎无关, 两种实现都必须满足)。 */
const CORPUS: MemoryEntryInput[] = [
  entry({ id: "c1", content: "所有容器实际上都有并发策略问题" }),
  entry({ id: "c2", content: "数据库连接池超时设置" }),
  entry({ id: "c3", content: "Prefer pnpm over npm in monorepos" }),
  entry({ id: "c4", content: "每次部署之前要跑一遍完整校验" }),
];

const GOLDEN: Array<{ query: string; expectTop3: string[] }> = [
  { query: "并发", expectTop3: ["c1"] },
  { query: "连接池", expectTop3: ["c2"] },
  { query: "pnpm", expectTop3: ["c3"] },
  { query: "部署前校验", expectTop3: ["c4"] },
];

export function describeRetrieval(spec: RetrievalSpec): void {
  describe(`retrieval conformance: ${spec.name}`, () => {
    let harness: RetrievalHarness;
    let retriever: HybridRetriever;

    beforeEach(async () => {
      harness = await spec.create();
      const vectorIndex =
        spec.vector === false ? undefined : new LinearVectorIndex({ embedder: stubEmbedder, floor: 0.5 });
      retriever = new HybridRetriever(harness.source, vectorIndex ? { vectorIndex } : {});
      for (const input of CORPUS) await harness.source.add(input);
    });
    afterEach(async () => {
      await harness.dispose?.();
    });

    it("黄金集: 每个查询的期望条目进入 top-3 (召回有效性)", () => {
      for (const { query, expectTop3 } of GOLDEN) {
        const out = retriever.retrieveSync({ text: query, limit: 3 });
        const ids = out.hits.map((h) => h.entry.id);
        expect(ids, `query=${query} got=${ids.join(",")}`).toContain(expectTop3[0]);
      }
    });

    it("无关查询不返回东西 (宁可不注入, 也不要噪声)", () => {
      expect(retriever.retrieveSync({ text: "量子退相干实验装置", limit: 5 }).hits).toEqual([]);
    });

    it("确定性: 同一请求两次结果一致 (顺序也一致)", () => {
      const first = retriever.retrieveSync({ text: "并发", limit: 5 }).hits.map((h) => h.entry.id);
      const second = retriever.retrieveSync({ text: "并发", limit: 5 }).hits.map((h) => h.entry.id);
      expect(first).toEqual(second);
    });

    it("治理: 已确认规则保底进入结果; 未确认 rule 永不出现", async () => {
      await harness.source.add(
        entry({
          id: "rule-ok",
          kind: "rule",
          scope: "global",
          content: "涉及容器并发时先检查并发策略",
          confirmedBy: "hx",
          confirmedAt: T.assertedAt,
        }),
      );
      const out = retriever.retrieveSync({ text: "与记忆完全无关的一句话", limit: 5 });
      expect(out.hits.map((h) => h.entry.id)).toContain("rule-ok");
      expect(out.hits.find((h) => h.entry.id === "rule-ok")?.channels).toContain("rules");
      // 未确认的 rule 在写入层就被拒 (写不进去就永远召不回)
      await expect(
        Promise.resolve().then(() =>
          harness.source.add(entry({ id: "rule-bad", kind: "rule", scope: "global", content: "未确认规则" })),
        ),
      ).rejects.toThrow(/confirmation/);
    });

    it("预算: token 预算与条数上限都是硬约束", () => {
      const out = retriever.retrieveSync({ text: "容器 并发 部署 连接池 pnpm", limit: 2, tokenBudget: 1000 });
      expect(out.hits.length).toBeLessThanOrEqual(2);
      const tight = retriever.retrieveSync({ text: "容器 并发 部署 连接池 pnpm", limit: 10, tokenBudget: 12 });
      expect(tight.tokens).toBeLessThanOrEqual(12);
    });

    it("演化: 命中旧版本时只注入最新 active 版本", async () => {
      await harness.source.add(
        entry({ id: "v1", content: "容器并发上限设为 10", status: "superseded", relations: [{ type: "supersededBy", toId: "v2" }] }),
      );
      await harness.source.add(
        entry({ id: "v2", content: "容器并发上限改为 50", relations: [{ type: "supersedes", toId: "v1" }] }),
      );
      const ids = retriever.retrieveSync({ text: "容器并发上限", limit: 5 }).hits.map((h) => h.entry.id);
      expect(ids).toContain("v2");
      expect(ids).not.toContain("v1");
    });

    it("可见性: shadow/expired 不参与检索", async () => {
      await harness.source.add(entry({ id: "s1", content: "已被撤回的并发结论", status: "shadow" }));
      await harness.source.add(entry({ id: "e1", content: "已过期的并发结论", status: "expired" }));
      const ids = retriever.retrieveSync({ text: "并发结论", limit: 10 }).hits.map((h) => h.entry.id);
      // 注意: 语料里其它相关条目仍应被召回 —— 契约是"这两个 id 不出现", 不是"结果为空"。
      expect(ids).not.toContain("s1");
      expect(ids).not.toContain("e1");
    });

    it("图扩展: 结构相关的邻居被召回并给出可审计的 why", async () => {
      await harness.source.add(
        entry({ id: "seed", content: "容器并发策略缺失", relations: [{ type: "relates", toId: "neighbor", weight: 0.9 }] }),
      );
      await harness.source.add(entry({ id: "neighbor", content: "部署流水线上的其它注意点" }));
      const out = retriever.retrieveSync({ text: "容器并发策略", limit: 5 });
      const hit = out.hits.find((h) => h.entry.id === "neighbor");
      expect(hit?.channels).toContain("graph");
      expect(hit?.why).toContain("graph:relates:seed");
    });

    it("能力自述与降级可见性一致", () => {
      const caps = retriever.capabilities();
      const degraded = retriever.retrieveSync({ text: "并发", limit: 3 }).degraded;
      if (spec.vector === false) {
        expect(caps.semantic).toBe(false);
        expect(degraded.some((d) => d.includes("semantic"))).toBe(true);
      } else {
        expect(caps.semantic).toBe(true);
        expect(degraded.some((d) => d.includes("semantic"))).toBe(false);
      }
    });

    if (spec.vector !== false) {
      it("向量通道: 字面不重合但语义相近的条目可召回", () => {
        const out = retriever.retrieveSync({ text: "上线之前要做什么检查", limit: 5 });
        const hit = out.hits.find((h) => h.entry.id === "c4");
        expect(hit?.channels).toContain("vector");
      });
    }
  });
}
