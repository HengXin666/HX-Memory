// tests/conformance/suite.ts — 引擎准入的 conformance 套件 (ADR-020)。
//
// 这是"存储/检索引擎可插拔"这句话的唯一保障: 任何新引擎 (LanceDB/Qdrant/远端/内存/文件)
// 都必须跑通同一份契约测试, 才能进 src/storage/ 或 src/engines/。
//
// 套件只测**端口契约**, 不测实现细节:
//   1. 写入 → 读取往返无损 (含 relations/tags/structured/演化字段);
//   2. 治理铁律 (未确认 rule 拒绝) 在每个引擎上都必须成立;
//   3. query 的条件语义 (kind/scope/project/tag/at/limit/shadow 可见性);
//   4. 关系遍历的可见性; 撤回是 shadow (持久, 不复活);
//   5. 能力声明与真实行为一致 (声称有全文检索就必须能召回中文 2 字查询);
//   6. 可重建引擎: 重建幂等 + verify 全绿 + 重建不复活撤回;
//   7. 持久化引擎: 重开后数据仍在。
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import type { MemoryEntry, MemoryEntryInput, Query } from "../../src/kernel/types.ts";
import type {
  MemoryStore,
  Rebuildable,
  RetrievalSource,
  SyncMemoryStore,
} from "../../src/kernel/ports.ts";

export interface BackendHarness {
  store: MemoryStore & Partial<SyncMemoryStore> & Partial<RetrievalSource> & Partial<Rebuildable>;
  /** 持久化后端: 关闭并重开 (验证"重启后数据还在")。 */
  reopen?(): Promise<void> | void;
  /** 清理 (内存实现无需实现)。 */
  dispose?(): Promise<void> | void;
}

export interface BackendSpec {
  name: string;
  create(): Promise<BackendHarness> | BackendHarness;
  supports: {
    /** 实现了 Rebuildable (能从真相全量重建 + 自检)。 */
    rebuild: boolean;
    /** 数据在进程/实例重启后仍在。 */
    persistence: boolean;
    /** searchText 是真实全文检索 (BM25 级), 而不是子串兜底。 */
    fullText: boolean;
  };
}

const T = { validAt: "2026-06-01T00:00:00.000Z", assertedAt: "2026-06-01T00:00:00.000Z" };

function entry(over: Partial<MemoryEntryInput> = {}): MemoryEntryInput {
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
 * 断言"抛错或 reject" —— 端口允许同步与异步实现 (Awaitable),
 * 直接写 `await expect(fn()).rejects` 在同步实现上会逃逸成未捕获异常。
 */
async function expectFailure(fn: () => unknown, pattern?: RegExp): Promise<void> {
  let failed = false;
  let message = "";
  try {
    await fn();
  } catch (error) {
    failed = true;
    message = String(error);
  }
  if (!failed) throw new Error("expected the call to fail, but it succeeded");
  if (pattern && !pattern.test(message)) {
    throw new Error("expected failure matching " + pattern + ", got: " + message);
  }
}

function rule(over: Partial<MemoryEntryInput> = {}): MemoryEntryInput {
  return {
    kind: "rule",
    content: "涉及容器/并发时先检查并发策略",
    source: "review:confirm",
    scope: "global",
    ts: T,
    confirmedBy: "hx",
    confirmedAt: "2026-06-01T00:00:00.000Z",
    ...over,
  };
}

export function describeBackend(spec: BackendSpec): void {
  describe(`conformance: ${spec.name}`, () => {
    let harness: BackendHarness;

    beforeEach(async () => {
      harness = await spec.create();
    });
    afterEach(async () => {
      await harness.dispose?.();
    });

    const store = (): BackendHarness["store"] => harness.store;

    it("端口形状: 必需方法都存在", () => {
      for (const method of ["add", "get", "query", "all", "traverse", "update", "remove"] as const) {
        expect(typeof store()[method]).toBe("function");
      }
      if (spec.supports.rebuild) expect(typeof store().rebuildFromTruth).toBe("function");
    });

    it("写入 → 读取: 全部字段逐一往返 (含演化字段)", async () => {
      const input = entry({
        id: "c1",
        content: "容器并发要显式设上限",
        project: "api",
        scope: "project",
        tags: ["concurrency", "container"],
        entities: ["容器"],
        importance: 8,
        confidence: 0.9,
        reinforcement: 2,
        lastHitAt: "2026-06-02T00:00:00.000Z",
        expiresAt: "2027-06-01T00:00:00.000Z",
        derivedFrom: ["ep-1"],
        mergedFrom: ["old-1"],
        structured: { summary: "摘要", points: ["要点"] },
        relations: [{ type: "relates", toId: "c2", weight: 0.5 }],
      });
      const created = await store().add(input);
      const loaded = await store().get(created.id);
      expect(loaded).toEqual(created);
      expect(loaded?.entities).toEqual(["容器"]);
      expect(loaded?.importance).toBe(8);
      expect(loaded?.derivedFrom).toEqual(["ep-1"]);
      expect(loaded?.structured).toEqual({ summary: "摘要", points: ["要点"] });
    });

    it("治理铁律: 未确认的 rule 一律拒绝 (换引擎不等于换规则)", async () => {
      await expectFailure(
        () => store().add(rule({ id: "r-bad", confirmedBy: undefined, confirmedAt: undefined })),
        /confirmation/,
      );
      const ok = await store().add(rule({ id: "r-ok" }));
      expect(ok.kind).toBe("rule");
    });

    it("query: 条件过滤 (kind/scope/project/tag/at/limit)", async () => {
      await store().add(entry({ id: "a", project: "api", scope: "project", tags: ["concurrency"] }));
      await store().add(entry({ id: "b", project: "web", scope: "project" }));
      await store().add(entry({ id: "c", kind: "decision", content: "决定: 采用 pnpm" }));
      await store().add(rule({ id: "r1" }));

      expect((await store().query({ kind: "lesson" })).map((e) => e.id).sort()).toEqual(["a", "b"]);
      expect((await store().query({ scope: "global" })).map((e) => e.id)).toEqual(["r1"]);
      expect((await store().query({ project: "api" })).map((e) => e.id)).toEqual(["a"]);
      expect((await store().query({ tag: "concurrency" })).map((e) => e.id)).toEqual(["a"]);
      expect((await store().query({ kind: "lesson", limit: 1 })).length).toBe(1);
      expect((await store().query({ at: "2026-05-31T00:00:00.000Z" })).length).toBe(0);
      expect((await store().query({ at: "2026-06-01T00:00:00.000Z" })).length).toBe(4);
    });

    it("关系遍历: 命中目标条目; 撤回的邻居不可见", async () => {
      await store().add(entry({ id: "target", content: "被引用的条目" }));
      await store().add(
        entry({ id: "from", relations: [{ type: "relates", toId: "target" }] }),
      );
      expect((await store().traverse("from", "relates")).map((e) => e.id)).toEqual(["target"]);
      await store().remove("target");
      expect(await store().traverse("from", "relates")).toEqual([]);
    });

    it("撤回是 shadow: get 仍可见, query 不可见 (可审计, 不物理删除)", async () => {
      const created = await store().add(entry({ id: "gone" }));
      await store().remove(created.id);
      const loaded = await store().get(created.id);
      expect(loaded).not.toBeNull();
      expect(loaded?.status).toBe("shadow");
      expect(await store().query({})).toEqual([]);
      expect((await store().query({ includeShadow: true })).map((e) => e.id)).toEqual([created.id]);
      await store().remove(created.id); // 幂等
      expect((await store().get(created.id))?.status).toBe("shadow");
    });

    it("all() 不被默认 limit 截断 (warmUp/重建依赖全量)", async () => {
      for (let i = 0; i < 60; i++) {
        await store().add(entry({ id: "m" + i, content: "第 " + i + " 条踩坑记录" }));
      }
      expect((await store().all()).length).toBe(60);
    });

    it("update: 打补丁与替换 (内容/标签/关系/演化字段)", async () => {
      const created = await store().add(entry({ id: "u1", tags: ["a"] }));
      await store().update(created.id, { content: "改后的内容", tags: ["b"], importance: 3 });
      const updated = await store().get(created.id);
      expect(updated?.content).toBe("改后的内容");
      expect(updated?.tags).toEqual(["b"]);
      expect(updated?.importance).toBe(3);
      await expectFailure(() => store().update("nope", { content: "x" }));
    });

    if (spec.supports.fullText) {
      it("全文检索: 中文 2 字查询可召回, 无关查询为空", async () => {
        await store().add(entry({ id: "cn1", content: "所有容器实际上都有并发策略问题" }));
        await store().add(entry({ id: "cn2", content: "数据库连接池超时设置" }));
        const hits = await store().searchText!("并发", 10);
        expect(hits.map((e) => e.id)).toContain("cn1");
        expect(hits.map((e) => e.id)).not.toContain("cn2");
        expect(await store().searchText!("量子退相干实验", 10)).toEqual([]);
      });
    } else {
      it("能力自述与实际一致: 没有 BM25 就不声称 fullText", () => {
        const capabilities = store().capabilities;
        if (capabilities) expect(capabilities().fullText).toBe(false);
      });
    }

    if (spec.supports.rebuild) {
      it("重建幂等 + verify 全绿", async () => {
        await store().add(entry({ id: "x1", content: "第一条踩坑" }));
        await store().add(entry({ id: "x2", content: "第二条踩坑" }));
        const first = await store().rebuildFromTruth!();
        const second = await store().rebuildFromTruth!();
        expect(first).toBe(2);
        expect(second).toBe(2);
        const report = await store().verify!();
        expect(report.ok).toBe(true);
        expect(report.truth).toBe(report.index);
      });

      it("重建不复活撤回 (撤回持久)", async () => {
        const created = await store().add(entry({ id: "revive" }));
        await store().remove(created.id);
        await store().rebuildFromTruth!();
        const loaded = await store().get(created.id);
        expect(loaded?.status).toBe("shadow");
        expect(await store().query({})).toEqual([]);
      });
    }

    if (spec.supports.persistence) {
      it("重开后数据仍在 (真相不在内存里)", async () => {
        await store().add(entry({ id: "p1", content: "持久化验证" }));
        await harness.reopen?.();
        expect((await store().get("p1"))?.content).toBe("持久化验证");
      });
    }
  });
}
