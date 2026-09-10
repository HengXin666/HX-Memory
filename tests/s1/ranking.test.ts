// tests/s1/ranking.test.ts — 融合/衰减/预算的纯逻辑契约。
import { describe, expect, it } from "vitest";
import {
  HALF_LIFE_DAYS,
  applyTokenBudget,
  compositeScore,
  estimateTokens,
  jaccardSimilarity,
  mmrSelect,
  reinforcementFactor,
  rrfFuse,
  timeDecayFactor,
} from "../../src/kernel/ranking.ts";
import type { MemoryEntry } from "../../src/kernel/types.ts";

const entry = (over: Partial<MemoryEntry> = {}): MemoryEntry => ({
  id: "c1",
  kind: "lesson",
  content: "内容",
  source: "test",
  scope: "agent",
  ts: { validAt: "2026-01-01T00:00:00.000Z", assertedAt: "2026-01-01T00:00:00.000Z" },
  ...over,
});

describe("kernel/ranking", () => {
  it("RRF: 多通道命中 > 单通道; 通道名被记录 (可审计为什么召回)", () => {
    const fused = rrfFuse([
      { channel: "bm25", ids: ["a", "b"] },
      { channel: "vector", ids: ["b", "c"] },
    ]);
    const b = fused.get("b");
    const a = fused.get("a");
    expect(b && a && b.score > a.score).toBe(true);
    expect(b?.channels.sort()).toEqual(["bm25", "vector"]);
  });

  it("RRF: 通道权重生效 (保底通道可以压过普通通道)", () => {
    const fused = rrfFuse([
      { channel: "bm25", ids: ["x"] },
      { channel: "rules", ids: ["y"], weight: 3 },
    ]);
    expect((fused.get("y")?.score ?? 0) > (fused.get("x")?.score ?? 0)).toBe(true);
  });

  it("时间衰减: 半衰期处正好 0.5; rule 不衰减", () => {
    expect(timeDecayFactor(180, 180)).toBeCloseTo(0.5, 6);
    expect(timeDecayFactor(1000, Number.POSITIVE_INFINITY)).toBe(1);
    expect(HALF_LIFE_DAYS.rule).toBe(Number.POSITIVE_INFINITY);
    expect(HALF_LIFE_DAYS.event).toBeLessThan(HALF_LIFE_DAYS.decision);
  });

  it("强化: 命中越多分越高, 但对数增长 (不会霸榜)", () => {
    expect(reinforcementFactor(0)).toBe(1);
    expect(reinforcementFactor(10)).toBeGreaterThan(reinforcementFactor(1));
    expect(reinforcementFactor(1000)).toBeLessThan(3);
  });

  it("综合分: 旧条目降权; 同等条件下 importance 高的胜出", () => {
    const now = "2026-06-01T00:00:00.000Z";
    const old = compositeScore({
      base: 1,
      entry: entry({
        kind: "event",
        ts: { validAt: "2026-01-01T00:00:00.000Z", assertedAt: "2026-01-01T00:00:00.000Z" },
      }),
      now,
    });
    const recent = compositeScore({
      base: 1,
      entry: entry({
        kind: "event",
        ts: { validAt: "2026-05-30T00:00:00.000Z", assertedAt: "2026-05-30T00:00:00.000Z" },
      }),
      now,
    });
    expect(recent).toBeGreaterThan(old);
    const low = compositeScore({ base: 1, entry: entry({ importance: 1, kind: "rule" }), now });
    const high = compositeScore({ base: 1, entry: entry({ importance: 10, kind: "rule" }), now });
    expect(high).toBeGreaterThan(low);
  });

  it("老数据 (无 importance/reinforcement/lastHitAt) 行为中性: 不因缺字段被惩罚", () => {
    const now = "2026-01-01T00:00:00.000Z";
    const score = compositeScore({ base: 1, entry: entry({ kind: "fact" }), now });
    expect(score).toBeGreaterThan(0.5);
    expect(score).toBeLessThanOrEqual(1.5);
  });

  it("MMR: 去冗余真的生效 (两条近乎重复的内容只留一条)", () => {
    const items = [
      { id: "a", text: "容器并发策略问题" },
      { id: "b", text: "容器并发策略问题!" },
      { id: "c", text: "数据库连接池超时" },
    ];
    const picked = mmrSelect(
      items,
      () => 1,
      (x, y) => jaccardSimilarity(x.text, y.text),
      {
        limit: 2,
        lambda: 0.5,
      },
    );
    expect(picked.map((p) => p.id)).toContain("c");
    expect(picked.length).toBe(2);
  });

  it("预算裁剪: reserved 组优先; 超预算的被丢弃并给出原因", () => {
    const r = applyTokenBudget(
      [
        { item: "big-local", tokens: 100 },
        { item: "rule-1", tokens: 60, reserved: true },
        { item: "local-2", tokens: 50 },
      ],
      130,
    );
    expect(r.kept).toContain("rule-1");
    expect(r.kept).not.toContain("big-local");
    expect(r.dropped[0]).toEqual({ item: "big-local", reason: "budget" });
    expect(r.tokens).toBeLessThanOrEqual(130);
  });

  it("token 估算: 中文按字, 拉丁按 4 字符", () => {
    expect(estimateTokens("四个汉字")).toBe(4);
    expect(estimateTokens("abcdefgh")).toBe(2);
    expect(estimateTokens("")).toBe(0);
  });
});
