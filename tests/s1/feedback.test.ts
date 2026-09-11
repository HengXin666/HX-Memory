// tests/s1/feedback.test.ts — 负面召回标注的纯逻辑 (s1)。
//
// 这三条性质任何一个退化都会静默地坏事:
//   1. 只记坏的 —— 一旦出现"正向计数"的入口, 模型就会被诱导逐条表态 (义务感噪声);
//   2. 两类分开 —— 合成一个分数会丢掉"是排序问题还是内容问题"这个指向;
//   3. 小样本收缩 —— 曝光 1 次错 1 次就把条目一棒打死, 单次标注没有统计意义。
import { describe, expect, it } from "vitest";
import {
  NO_FEEDBACK,
  badCount,
  needsReview,
  normalizeFeedback,
  qualityFactor,
  REVIEW_MIN_EXPOSURE,
  REVIEW_MIN_RATIO,
} from "../../src/kernel/feedback.ts";
import { compositeScore } from "../../src/kernel/ranking.ts";
import type { MemoryEntry } from "../../src/kernel/types.ts";

describe("normalizeFeedback: 坏值不让记忆失败", () => {
  it("负数/非有限值归零, 全零视为没有标注", () => {
    expect(normalizeFeedback({ irrelevant: -3, wrong: 2.7 })).toEqual({ irrelevant: 0, wrong: 2 });
    expect(normalizeFeedback({ irrelevant: Number.NaN, wrong: Number.POSITIVE_INFINITY })).toBeUndefined();
    expect(normalizeFeedback({ irrelevant: 0, wrong: 0 })).toBeUndefined();
  });

  it("非对象输入返回 undefined (而不是抛错)", () => {
    expect(normalizeFeedback(undefined)).toBeUndefined();
    expect(normalizeFeedback("bad")).toBeUndefined();
    expect(normalizeFeedback(null)).toBeUndefined();
  });

  it("只接受负面字段: 正向字段被忽略 (没有 used 这种入口)", () => {
    const out = normalizeFeedback({ used: 99, wrong: 1 } as unknown);
    expect(out).toEqual({ irrelevant: 0, wrong: 1 });
    expect(Object.keys(out!)).not.toContain("used");
  });
});

describe("badCount", () => {
  it("两类相加", () => {
    expect(badCount({ irrelevant: 2, wrong: 3 })).toBe(5);
    expect(badCount(undefined)).toBe(0);
    expect(badCount(NO_FEEDBACK)).toBe(0);
  });
});

describe("qualityFactor: 只降权、小样本收缩", () => {
  it("零坏评恒为 1 (老数据行为不变)", () => {
    expect(qualityFactor(undefined, 10)).toBe(1);
    expect(qualityFactor(NO_FEEDBACK, 10)).toBe(1);
  });

  it("零曝光不受影响 (从未展示过就谈不上质量)", () => {
    expect(qualityFactor({ irrelevant: 3, wrong: 3 }, 0)).toBe(1);
  });

  it("曝光 1 次错 1 次时不被一棒打死 (小样本收缩)", () => {
    const small = qualityFactor({ irrelevant: 0, wrong: 1 }, 1);
    expect(small).toBeGreaterThan(0.5);
  });

  it("坏评占比高时显著降权, 但有下限 0.2 (丢弃是治理动作, 不是排序动作)", () => {
    const heavy = qualityFactor({ irrelevant: 0, wrong: 20 }, 20);
    expect(heavy).toBeLessThan(0.5);
    expect(heavy).toBeGreaterThanOrEqual(0.2);
  });

  it("单调: 坏评越多因子越低", () => {
    const a = qualityFactor({ irrelevant: 1, wrong: 0 }, 10);
    const b = qualityFactor({ irrelevant: 5, wrong: 0 }, 10);
    const c = qualityFactor({ irrelevant: 9, wrong: 0 }, 10);
    expect(a).toBeGreaterThan(b);
    expect(b).toBeGreaterThan(c);
  });
});

describe("接入 compositeScore: 标注必须真的影响排序", () => {
  const T = { validAt: "2026-06-01T00:00:00.000Z", assertedAt: "2026-06-01T00:00:00.000Z" };
  const entry = (feedback?: MemoryEntry["feedback"]): MemoryEntry => ({
    id: "m1",
    kind: "lesson",
    content: "容器并发上限要显式设置",
    source: "t",
    scope: "global",
    ts: T,
    reinforcement: 10,
    lastHitAt: T.validAt,
    ...(feedback ? { feedback } : {}),
  });

  it("坏评让综合分下降, 且与 qualityFactor 完全一致 (没有第二套口径)", () => {
    const now = "2026-06-01T00:00:00.000Z";
    const clean = compositeScore({ base: 1, entry: entry(), now });
    const fb = { irrelevant: 0, wrong: 8 };
    const flagged = compositeScore({ base: 1, entry: entry(fb), now });
    expect(flagged).toBeLessThan(clean);
    expect(flagged / clean).toBeCloseTo(qualityFactor(fb, 10), 10);
  });

  it("无标注时综合分与改动前一致 (老数据行为不变)", () => {
    const now = "2026-06-01T00:00:00.000Z";
    const withUndefined = compositeScore({ base: 1, entry: entry(), now });
    const withNoFeedback = compositeScore({ base: 1, entry: entry(NO_FEEDBACK), now });
    expect(withNoFeedback).toBe(withUndefined);
  });
});

describe("needsReview: 两个条件必须同时满足", () => {
  it("曝光不足时不触发 (绝对次数会过早动手)", () => {
    expect(needsReview({ irrelevant: 0, wrong: 4 }, REVIEW_MIN_EXPOSURE - 1)).toBe(false);
  });

  it("占比不足时不触发", () => {
    expect(needsReview({ irrelevant: 0, wrong: 2 }, 10)).toBe(false);
  });

  it("曝光够且占比够才触发; 边界按 >= 判定", () => {
    expect(needsReview({ irrelevant: 0, wrong: 3 }, 5)).toBe(true);
    // 恰好一半: bad/exposure = 5/10 = 0.5 >= REVIEW_MIN_RATIO
    expect(needsReview({ irrelevant: 5, wrong: 0 }, 10)).toBe(true);
    expect(needsReview({ irrelevant: 4, wrong: 0 }, 10)).toBe(false);
    expect(REVIEW_MIN_RATIO).toBe(0.5);
  });

  it("零坏评永不触发", () => {
    expect(needsReview(NO_FEEDBACK, 100)).toBe(false);
    expect(needsReview(undefined, 100)).toBe(false);
  });
});
