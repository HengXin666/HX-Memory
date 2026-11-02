// tests/frustration/classifier.test.ts — 线性打分器: 确定性、阈值口径、分组交叉验证不泄漏会话。
import { describe, expect, it } from "vitest";
import { assignFolds, auc, confusion, crossValidate, DEFAULT_TRAIN, explain, fit, pickThreshold, wilson, type TrainSample } from "../../src/frustration/classifier.ts";
import { extractFeatures } from "../../src/frustration/features.ts";

const G = { lex: true, cue: true, shape: true, ngram: false };
const S: TrainSample[] = [];
for (let i = 0; i < 12; i++) {
  S.push({ id: "p" + i, group: "g" + (i % 4), text: i % 2 ? "你听不懂吗？我说的是 A" : "傻逼, 又错了", y: 1 });
  S.push({ id: "n" + i, group: "g" + (i % 4), text: i % 2 ? "帮我看下这个函数" : "把日志时间改成 hh:mm:ss", y: 0 });
}

describe("features", () => {
  it("同一文本得到同一组特征; 技术词被遮掉后不触发词表", () => {
    expect([...extractFeatures("你听不懂吗？", G)]).toEqual([...extractFeatures("你听不懂吗？", G)]);
    expect(extractFeatures("Node 的垃圾回收什么时候触发", G).has("lex:blame-method")).toBe(false);
  });
});

describe("fit / explain", () => {
  it("同样本同超参 ⇒ 逐位相同的权重", () => {
    const o = { ...DEFAULT_TRAIN, groups: G };
    expect(JSON.stringify(fit(S, o))).toBe(JSON.stringify(fit(S, o)));
  });
  it("explain 给出得分与贡献, 命中与阈值一致", () => {
    const m = fit(S, { ...DEFAULT_TRAIN, groups: G });
    const e = explain(m, "你听不懂吗？我说的是 A");
    expect(e.hit).toBe(e.score >= e.threshold);
    expect(e.contributions.length).toBeGreaterThan(0);
  });
});

describe("pickThreshold", () => {
  it("训练集误报率不超过目标", () => {
    const scored = [...Array(20)].map((_, i) => ({ s: i, y: 0 as const }));
    const t = pickThreshold(scored, 0.05);
    expect(scored.filter((r) => r.s >= t).length).toBeLessThanOrEqual(1);
  });
});

describe("crossValidate", () => {
  it("同一会话的样本永远在同一折 (不泄漏)", () => {
    const folds = assignFolds(S.map((s) => s.group), 2);
    const preds = crossValidate(S, { ...DEFAULT_TRAIN, groups: G, steps: 100 }, 2, 2);
    for (const p of preds) expect(p.fold).toBe(String(folds.get(p.group)));
  });
  it("confusion / auc / wilson 口径", () => {
    expect(confusion([{ y: 1, hit: true }, { y: 0, hit: true }])).toMatchObject({ tp: 1, fp: 1, recall: 1, fpr: 1 });
    expect(auc([{ score: 1, y: 1 }, { score: 0, y: 0 }])).toBe(1);
    const [lo, hi] = wilson(5, 10);
    expect(lo).toBeLessThan(0.5);
    expect(hi).toBeGreaterThan(0.5);
  });
});
