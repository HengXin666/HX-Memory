// tests/s1/rule-shape.test.ts — 占位草稿的"生成与识别同源"契约。
//
// 为什么值得钉: 判据一旦与生成模板漂移 (改了一处忘了另一处), 挡掉的就不是占位草稿,
// 而是**真正的规则** (或者一条都挡不住, 回到"10 条草稿吃光 400 token 保底预算"的老问题)。
// 两种失败都不会有任何报错 —— 因此模板只能有一份, 且必须被断言。
import { describe, expect, it } from "vitest";
import { heuristicRuleText, isHeuristicRulePlaceholder } from "../../src/kernel/rule-shape.ts";

describe("占位草稿判据", () => {
  it("生成出来的模板一定被识别 (同源, 不靠人工同步)", () => {
    for (const [theme, n] of [
      ["api", 4],
      ["timeout", 2],
      ["memory", 10],
      ["含空格 的主题", 3],
    ] as const) {
      expect(isHeuristicRulePlaceholder(heuristicRuleText(theme, n))).toBe(true);
    }
  });

  it("真实提炼出来的规则**不**被误判 (宁可漏挡, 不可错杀)", () => {
    const real = [
      "Node strip-only TS 模式不支持构造器参数属性, 类需显式声明字段",
      "派生索引必须可全量重建, 带版本身份, 不符即重建",
      "经验: 这条虽然以'经验:'开头, 但它是一条真正被人写清楚的约束",
    ];
    for (const rule of real) expect(isHeuristicRulePlaceholder(rule)).toBe(false);
  });

  it("人工把占位草稿重写之后, 就不再是草稿 (这是有意为之的语义)", () => {
    const original = heuristicRuleText("api", 4);
    expect(isHeuristicRulePlaceholder(original)).toBe(true);
    const rewritten = "涉及容器并发时先检查并发策略";
    expect(isHeuristicRulePlaceholder(rewritten)).toBe(false);
  });

  it("形状要精确: 缺一段 / 数字变成非数字都不算 (避免宽松正则误伤)", () => {
    expect(isHeuristicRulePlaceholder("经验: api 相关的 4 条实例已沉淀")).toBe(false);
    expect(isHeuristicRulePlaceholder("经验: api 相关的 N 条实例已沉淀, 建议复核提炼为跨项目规则")).toBe(
      false,
    );
  });

  it("前后空白不影响判定 (落盘/回读可能带空白)", () => {
    expect(isHeuristicRulePlaceholder("  " + heuristicRuleText("ui", 2) + "\n")).toBe(true);
  });
});
