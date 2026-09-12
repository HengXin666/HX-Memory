// tests/s1/retrieval.test.ts — 检索层契约 (纯逻辑 + 假 source, 无存储/无宿主)。
//
// 这个文件钉住 v2 检索的五条不变量:
//   1. 中文 2 字查询可召回 (bigram 兜底) 且噪声被覆盖率过滤压住;
//   2. 已确认的跨项目规则走保底通道, 不会被预算挤掉; 未确认的 rule 永不召回 (治理铁律);
//   3. 命中旧版本 → 注入最新 active 版本 (演化链上溯);
//   4. 图扩展召回"结构相关但字面不相关"的记忆, 并给出可审计的 why;
//   5. token 预算是硬约束 (注入多少字才是真实约束)。
import { describe, expect, it } from "vitest";
import { HybridRetriever } from "../../src/retrieval/hybrid.ts";
import { termStreams } from "../../src/kernel/cjk.ts";
import type { MemoryEntry, Query } from "../../src/kernel/types.ts";
import type { RetrievalSource } from "../../src/kernel/ports.ts";

const T = { validAt: "2026-06-01T00:00:00.000Z", assertedAt: "2026-06-01T00:00:00.000Z" };

function make(over: Partial<MemoryEntry> & { id: string; content: string }): MemoryEntry {
  return {
    kind: "lesson",
    source: "test",
    scope: "agent",
    ts: T,
    status: "active",
    ...over,
  };
}

/** 假 source: 用"查询 bigram 命中数"模拟全文索引, 用 relations 模拟图。 */
class FakeSource implements RetrievalSource {
  constructor(private readonly entries: MemoryEntry[]) {}
  searchText(text: string, limit = 20): MemoryEntry[] {
    const streams = termStreams(text);
    const probe = [...streams.words, ...streams.bigrams];
    return this.entries
      .map((e) => {
        const hay = e.content.toLowerCase();
        const hit = probe.filter((t) => hay.includes(t)).length;
        return { e, hit };
      })
      .filter((x) => x.hit > 0)
      .sort((a, b) => b.hit - a.hit)
      .slice(0, limit)
      .map((x) => x.e);
  }
  query(q: Query): MemoryEntry[] {
    return this.entries.filter((e) => {
      if (q.kind && e.kind !== q.kind) return false;
      if (q.scope && e.scope !== q.scope) return false;
      if (q.tag && !(e.tags ?? []).includes(q.tag)) return false;
      if (q.project && e.project !== q.project) return false;
      return true;
    });
  }
  get(id: string): MemoryEntry | null {
    return this.entries.find((e) => e.id === id) ?? null;
  }
  traverse(fromId: string, relationType: string): MemoryEntry[] {
    const from = this.entries.find((e) => e.id === fromId);
    const targets = (from?.relations ?? [])
      .filter((r) => r.type === relationType)
      .map((r) => r.toId);
    return this.entries.filter((e) => targets.includes(e.id) && e.status !== "shadow");
  }
}

const retriever = (entries: MemoryEntry[], now = "2026-06-01T00:00:00.000Z") =>
  new HybridRetriever(new FakeSource(entries), { now: () => now });

describe("检索: 相关性 (中文 2 字 + 覆盖率过滤)", () => {
  it("2 字中文查询召回正确条目", () => {
    const r = retriever([
      make({ id: "a", content: "所有容器实际上都有并发策略问题" }),
      make({ id: "b", content: "数据库连接池超时设置" }),
    ]);
    const out = r.retrieveSync({ text: "并发" });
    expect(out.hits.map((h) => h.entry.id)).toEqual(["a"]);
  });

  it("覆盖率过滤: 只共享一个 bigram 的噪声候选被丢弃", () => {
    const r = retriever([
      make({ id: "noise", content: "记录一下今天的事情" }),
      make({ id: "real", content: "踩坑记录: 容器并发策略缺失" }),
    ]);
    const out = r.retrieveSync({ text: "踩坑记录容器并发" });
    const ids = out.hits.map((h) => h.entry.id);
    expect(ids).toContain("real");
    expect(ids).not.toContain("noise");
  });

  it("无关查询不返回东西 (宁可不注入, 也不要噪声)", () => {
    const r = retriever([make({ id: "a", content: "容器并发策略" })]);
    expect(r.retrieveSync({ text: "量子退相干实验" }).hits).toEqual([]);
  });

  it("时间衰减: 同样相关时, 新条目排在旧条目前面", () => {
    const r = retriever(
      [
        make({
          id: "old",
          content: "并发上限设置",
          kind: "event",
          ts: { validAt: "2025-01-01T00:00:00.000Z", assertedAt: "2025-01-01T00:00:00.000Z" },
        }),
        make({
          id: "new",
          content: "并发上限设置",
          kind: "event",
          ts: { validAt: "2026-05-31T00:00:00.000Z", assertedAt: "2026-05-31T00:00:00.000Z" },
        }),
      ],
      "2026-06-01T00:00:00.000Z",
    );
    const out = r.retrieveSync({ text: "并发上限" });
    expect(out.hits[0]?.entry.id).toBe("new");
  });
});

describe("检索: 返回顺序必须按综合分降序", () => {
  /**
   * 这条不变量曾经被破坏, 代价很大。
   *
   * MMR 的产出是**挑选顺序** (相关性 × 差异度的折中), 不是相关度顺序; 旧实现把
   * mmrSelect 的输出直接当排名返回, 于是分数最高的条目会因为"与已选项相似"被排到后面。
   * 实测后果: 接入真语义通道后 (向量候选多、相似度普遍高) R@1 从 0.726 掉到 0.099,
   * 而 gold 的分数其实全场最高 —— 是**排序**错了, 不是召回错了。
   */
  const many = (): MemoryEntry[] => {
    // 一批高度相似的条目: MMR 会把它们彼此视为冗余, 从而打乱"分数降序"。
    const out: MemoryEntry[] = [];
    for (let i = 0; i < 6; i++) {
      out.push(make({ id: "sim-" + i, content: "并发上限设置 显式声明 容器并发策略 " + i }));
    }
    out.push(make({ id: "target", content: "并发上限设置 显式声明" }));
    return out;
  };

  it("hits 按 score 单调不增", () => {
    const r = retriever(many());
    const out = r.retrieveSync({ text: "并发上限设置 显式声明", limit: 7, tokenBudget: 1_000_000 });
    expect(out.hits.length).toBeGreaterThan(1);
    for (let i = 1; i < out.hits.length; i++) {
      expect(out.hits[i]!.score).toBeLessThanOrEqual(out.hits[i - 1]!.score + 1e-9);
    }
  });

  it("token 预算给足时, 分数最高的条目就是 hits[0]", () => {
    const r = retriever(many());
    const out = r.retrieveSync({ text: "并发上限设置 显式声明", limit: 7, tokenBudget: 1_000_000 });
    const best = Math.max(...out.hits.map((h) => h.score));
    expect(out.hits[0]!.score).toBeCloseTo(best, 9);
  });
});

describe("检索: 治理铁律 (规则通道)", () => {
  const rule = (over: Partial<MemoryEntry> = {}) =>
    make({
      id: "rule-1",
      kind: "rule",
      scope: "global",
      content: "凡是涉及容器/并发的任务, 先检查并发策略",
      confirmedBy: "hx",
      confirmedAt: "2026-05-01T00:00:00.000Z",
      ...over,
    });

  it("已确认的全局规则总是候选, 即使查询文本毫不相关 (跨项目不变量)", () => {
    const r = retriever([rule(), make({ id: "x", content: "前端样式调整" })]);
    const out = r.retrieveSync({ text: "前端样式" });
    expect(out.hits.map((h) => h.entry.id)).toContain("rule-1");
    expect(out.hits.find((h) => h.entry.id === "rule-1")?.channels).toContain("rules");
  });

  it("未确认的 rule 永不召回 (存储闸门之外的第二道闸门)", () => {
    const fake = rule({ id: "unconfirmed", confirmedBy: undefined, confirmedAt: undefined });
    const r = retriever([fake]);
    expect(r.retrieveSync({ text: "容器 并发" }).hits).toEqual([]);
  });

  it("预算不足时规则被保底保留, 长文本本地经验被丢弃", () => {
    const r = retriever([rule(), make({ id: "long", content: "并发".repeat(400) + "容器" })]);
    const out = r.retrieveSync({ text: "并发 容器", tokenBudget: 40, limit: 5 });
    expect(out.hits.map((h) => h.entry.id)).toContain("rule-1");
    expect(out.tokens).toBeLessThanOrEqual(40);
    expect(out.dropped.some((d) => d.reason === "budget")).toBe(true);
  });

  it("token 预算是硬约束", () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      make({ id: "m" + i, content: "容器并发策略第 " + i + " 条, 内容很长".repeat(5) }),
    );
    const r = retriever(many);
    const out = r.retrieveSync({ text: "容器并发策略", tokenBudget: 100, limit: 20 });
    expect(out.tokens).toBeLessThanOrEqual(100);
  });
});

describe("检索: 演化与关联", () => {
  it("命中旧版本 → 上溯到最新 active 版本 (注入最新, 历史仍可查)", () => {
    const old = make({
      id: "v1",
      content: "容器并发上限设为 10",
      status: "superseded",
      relations: [{ type: "supersededBy", toId: "v2" }],
    });
    const next = make({
      id: "v2",
      content: "容器并发上限改为 50",
      relations: [{ type: "supersedes", toId: "v1" }],
    });
    const out = retriever([old, next]).retrieveSync({ text: "容器并发上限" });
    expect(out.hits.map((h) => h.entry.id)).toEqual(["v2"]);
  });

  it("shadow/expired 条目不出现在默认结果里", () => {
    const r = retriever([
      make({ id: "s", content: "容器并发策略", status: "shadow" }),
      make({ id: "e", content: "容器并发策略", status: "expired" }),
    ]);
    expect(r.retrieveSync({ text: "容器并发策略" }).hits).toEqual([]);
  });

  it("图扩展召回字面不相关但结构相关的记忆, 并给出 why", () => {
    const seed = make({
      id: "seed",
      content: "容器并发策略缺失",
      relations: [{ type: "relates", toId: "related", weight: 0.9 }],
    });
    const related = make({ id: "related", content: "部署流水线上的其它注意点" });
    const out = retriever([seed, related]).retrieveSync({ text: "容器并发策略" });
    const hit = out.hits.find((h) => h.entry.id === "related");
    expect(hit).toBeDefined();
    expect(hit?.channels).toContain("graph");
    expect(hit?.why).toContain("graph:relates:seed");
  });

  it("asOf 时间切片: 未来才生效的记忆不参与检索", () => {
    const future = make({
      id: "future",
      content: "容器并发策略新规",
      ts: { validAt: "2027-01-01T00:00:00.000Z", assertedAt: "2026-06-01T00:00:00.000Z" },
    });
    const out = retriever([future]).retrieveSync({
      text: "容器并发策略",
      asOf: "2026-06-01T00:00:00.000Z",
    });
    expect(out.hits).toEqual([]);
  });
});

describe("检索: 能力自述 (降级必须可见)", () => {
  it("没有 embedding 时 degraded 明确说明回退到了什么", () => {
    const r = retriever([make({ id: "a", content: "容器并发" })]);
    const out = r.retrieveSync({ text: "容器并发" });
    expect(out.degraded.some((d) => d.includes("semantic"))).toBe(true);
    expect(r.capabilities().semantic).toBe(false);
  });
});