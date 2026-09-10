// tests/s1/adjudicator-digest.test.ts — 冲突裁决器与摘要整合的纯逻辑契约 (无 IO)。
//
// 断言的是**性质** (该取代就取代 / 不确定就不取代 / 同输入同输出 / 只吃 active),
// 不锁死具体分数与文案 —— 否则改一句 reason 就会让测试变红, 却什么行为都没坏。
import { describe, expect, it } from "vitest";
import { heuristicAdjudicator } from "../../src/evolution/adjudicator.ts";
import { heuristicDigestBuilder } from "../../src/app/digest.ts";
import type { MemoryEntry, MemoryKind, MemoryStatus } from "../../src/kernel/types.ts";

const T = { validAt: "2026-06-01T00:00:00.000Z", assertedAt: "2026-06-01T00:00:00.000Z" };

function entry(id: string, content: string, over: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id,
    kind: "lesson",
    content,
    source: "t",
    scope: "agent",
    ts: T,
    status: "active",
    ...over,
  };
}

const adjudicator = heuristicAdjudicator();

describe("启发式裁决器: 四种 verdict", () => {
  it("同 kind + 数字冲突 + 候选更晚且置信度不低 → supersede", async () => {
    const result = await adjudicator.adjudicate({
      candidate: {
        kind: "lesson",
        content: "容器并发上限是 50",
        confidence: 0.9,
        ts: { validAt: "2026-06-02T00:00:00.000Z", assertedAt: T.assertedAt },
      },
      target: entry("old", "容器并发上限是 10", { confidence: 0.7 }),
    });
    expect(result.verdict).toBe("supersede");
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
    expect(result.reason).toContain("50");
  });

  it("候选更早 (时间倒退) → keep-both, 不取代", async () => {
    const result = await adjudicator.adjudicate({
      candidate: {
        kind: "lesson",
        content: "容器并发上限是 50",
        confidence: 0.9,
        ts: { validAt: "2026-05-01T00:00:00.000Z", assertedAt: T.assertedAt },
      },
      target: entry("old", "容器并发上限是 10", { confidence: 0.7 }),
    });
    expect(result.verdict).toBe("keep-both");
    expect(result.reason.length).toBeGreaterThan(0);
  });

  it("候选置信度明显更低 → keep-both (证据更弱不推翻)", async () => {
    const result = await adjudicator.adjudicate({
      candidate: { kind: "lesson", content: "容器并发上限是 50", confidence: 0.2 },
      target: entry("old", "容器并发上限是 10", { confidence: 0.9 }),
    });
    expect(result.verdict).toBe("keep-both");
  });

  it("文本几乎等价 → duplicate", async () => {
    const result = await adjudicator.adjudicate({
      candidate: { kind: "lesson", content: "容器并发上限是 10 且必须显式设置" },
      target: entry("old", "容器并发上限是 10, 且必须显式设置"),
    });
    expect(result.verdict).toBe("duplicate");
    expect(result.reason).toContain("old");
  });

  it("无冲突 / 跨 kind / 目标是规则 / 缺 validAt → keep-both (保守到底)", async () => {
    const noConflict = await adjudicator.adjudicate({
      candidate: { kind: "lesson", content: "每次部署前要跑一次全量回归" },
      target: entry("old", "数据库连接池要设置超时"),
    });
    expect(noConflict.verdict).toBe("keep-both");

    const crossKind = await adjudicator.adjudicate({
      candidate: { kind: "decision", content: "容器并发上限是 50", confidence: 0.9 },
      target: entry("old", "容器并发上限是 10", { kind: "lesson" }),
    });
    expect(crossKind.verdict).toBe("keep-both");

    const ruleTarget = await adjudicator.adjudicate({
      candidate: { kind: "lesson", content: "容器并发上限是 50", confidence: 0.9 },
      target: entry("rule-1", "容器并发上限是 10", {
        kind: "rule",
        scope: "global",
        confirmedBy: "hx",
        confirmedAt: T.assertedAt,
      }),
    });
    expect(ruleTarget.verdict).toBe("keep-both");
    expect(ruleTarget.reason).toContain("rule");

    const noTs = await adjudicator.adjudicate({
      candidate: { kind: "lesson", content: "容器并发上限是 50", confidence: 0.9 },
      target: entry("old", "容器并发上限是 10"),
    });
    expect(noTs.verdict).toBe("keep-both");
  });

  it("reason 必填非空, confidence 落在 0..1, 且裁决是确定性的", async () => {
    const cases = [
      {
        candidate: { kind: "lesson" as const, content: "容器并发上限是 50", confidence: 0.9 },
        target: entry("old", "容器并发上限是 10"),
      },
      {
        candidate: { kind: "lesson" as const, content: "容器并发上限是 10 且必须显式设置" },
        target: entry("old", "容器并发上限是 10, 且必须显式设置"),
      },
      {
        candidate: { kind: "event" as const, content: "昨天部署失败" },
        target: entry("old", "容器并发上限是 10"),
      },
    ];
    for (const input of cases) {
      const first = await adjudicator.adjudicate(input);
      const second = await adjudicator.adjudicate(input);
      expect(first).toEqual(second);
      expect(first.reason.trim().length).toBeGreaterThan(0);
      expect(first.confidence).toBeGreaterThanOrEqual(0);
      expect(first.confidence).toBeLessThanOrEqual(1);
    }
  });
});

describe("启发式摘要整合", () => {
  const builder = heuristicDigestBuilder();

  it("空输入不抛错, 且明确说明无内容", async () => {
    const digest = await builder.build({ entries: [] });
    expect(digest.points).toEqual([]);
    expect(digest.summary).toContain("无");
    expect(digest.summary.length).toBeGreaterThan(0);
    expect(digest.title.length).toBeGreaterThan(0);
  });

  it("只吃 active: shadow / expired / superseded 都不进摘要", async () => {
    const entries: MemoryEntry[] = [
      entry("live", "容器并发要显式设上限", { importance: 9 }),
      entry("dead", "容器并发要显式设上限", { status: "shadow", importance: 10 }),
      entry("old", "这条已被取代", { status: "superseded", importance: 10 }),
      entry("expired", "这条已过期", { status: "expired", importance: 10 }),
      entry("merged", "这条已合并", { status: "merged", importance: 10 }),
    ];
    const digest = await builder.build({ entries });
    expect(digest.points).toEqual(["容器并发要显式设上限"]);
    expect(digest.summary).toContain("1 条 active");
    expect(digest.summary).not.toContain("已被取代");
    expect(JSON.stringify(digest)).not.toContain("这条已过期");
  });

  it("分组正确: 同一句的重述只出一个要点, kind 分布按出现次数统计", async () => {
    const entries: MemoryEntry[] = [
      entry("a", "容器并发要显式设上限", { kind: "lesson" }),
      entry("b", "容器并发: 要显式设上限!", { kind: "lesson" }),
      entry("c", "数据库连接池要设置超时", { kind: "fact" }),
    ];
    const digest = await builder.build({ entries });
    // 两条重述归为一个主题 → 总点数 2, 句数 3。
    expect(digest.points).toHaveLength(2);
    expect(digest.summary).toContain("3 条 active");
    expect(digest.summary).toContain("lesson 2");
    expect(digest.summary).toContain("fact 1");
  });

  it("points 按 出现次数 × importance 排序, 且不超过 maxPoints", async () => {
    const entries: MemoryEntry[] = [
      entry("low", "高重要但只出现一次", { importance: 10 }),
      entry("hi1", "被反复提到的那条", { importance: 9 }),
      entry("hi2", "被反复提到的那条", { importance: 9 }),
      entry("hi3", "被反复提到的那条", { importance: 9 }),
    ];
    const digest = await builder.build({ entries });
    expect(digest.points[0]).toBe("被反复提到的那条");

    const limited = heuristicDigestBuilder({ maxPoints: 1 });
    const small = await limited.build({ entries });
    expect(small.points).toHaveLength(1);
  });

  it("确定性: 同输入同输出 (顺序打乱也一样)", async () => {
    const entries: MemoryEntry[] = [
      entry("a", "第一条内容", { kind: "lesson", importance: 5 }),
      entry("b", "第二条内容", { kind: "decision", importance: 8 }),
      entry("c", "第三条内容", { kind: "fact", importance: 8 }),
    ];
    const first = await builder.build({ entries });
    const second = await builder.build({ entries });
    expect(first).toEqual(second);
    const shuffled = await builder.build({ entries: [entries[2]!, entries[0]!, entries[1]!] });
    expect(shuffled.points).toEqual(first.points);
    expect(shuffled.summary).toBe(first.summary);
  });

  it("项目维度: 主要项目写进 summary, project 进入标题范围", async () => {
    const entries: MemoryEntry[] = [
      entry("a", "alpha 项目的教训", { scope: "project", project: "alpha" }),
      entry("b", "alpha 项目的另一条教训", { scope: "project", project: "alpha" }),
      entry("c", "beta 项目的教训", { scope: "project", project: "beta" }),
    ];
    const digest = await builder.build({ entries, project: "alpha" });
    expect(digest.summary).toContain("alpha");
    expect(digest.summary).toContain("2 条");
  });
});
