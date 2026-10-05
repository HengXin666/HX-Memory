// tests/s2/always-on-budget-report.test.ts — "被配额挡掉的条目"必须可查。
//
// 为什么需要它 (2026-09-18 实测): 真实库有 **9 条已确认规则, 而 ruleBudgetRatio=0.6 的配额
// (240 token) 只够 7 条** —— 另 2 条**永远进不了保底通道**, 且**完全静默**
// (没有日志说"它因配额没注入")。用户看到的是"我确认过这条规则, 但它好像没生效"。
//
// 规则是**用户确认过的跨项目不变量**, 而 `always-on` 的承诺是**无条件注入** ——
// 因此"哪些规则被挡了"必须可查, 否则这个承诺无法被验证。
//
// 设计取舍: 用**新增出口** (`selectAlwaysOnDetailed`) 而非改 `selectAlwaysOn` 的返回类型 ——
// 后者会波及 10+ 个调用点 (含大量测试), 而其中只有面板/账本需要这个信息。
// 两者**共用同一实现**, 因此不存在口径分叉。
import { describe, expect, it } from "vitest";
import { selectAlwaysOn, selectAlwaysOnDetailed } from "../../src/trigger/policy.ts";
import { estimateTokens } from "../../src/kernel/ranking.ts";
import type { MemoryEntry } from "../../src/kernel/types.ts";

const T = { validAt: "2026-01-01T00:00:00Z", assertedAt: "2026-01-01T00:00:00Z" };
const rule = (id: string, content: string) =>
  ({ id, kind: "rule", content, source: "t", scope: "global", confirmedBy: "hx", confirmedAt: T.assertedAt, ts: T } as MemoryEntry);

describe("always-on 的配额阻挡必须可观测", () => {
  it("**规则超出配额时, 被挡的规则出现在 blocked 里**", () => {
    // 造 12 条规则 (每条 30 token ⇒ 总 360) + 1 条项目条目。
    //
    // ⚠ 必须**同时有非规则候选**: 判据是 `rules.length > 0 && others.length > 0` 才切分预算 ——
    // 只有规则时它用满总预算 (400), 12 条 (360) 全都能进。这是**正确的设计**
    // ("只有一组时用满, 不让分仓变成浪费"), 但测"规则被配额挡"时必须构造两组都有的情形。
    const others = [
      { id: "d0", kind: "decision", content: "项目决策 " + "填充".repeat(6), source: "t", scope: "project", project: "p", ts: T } as MemoryEntry,
    ];
    const rules = Array.from({ length: 12 }, (_, i) => rule("r" + i, "规则 " + i + " 的内容 " + "说明".repeat(8)));
    const sel = selectAlwaysOnDetailed([...rules, ...others], { project: "p", budgetTokens: 400, estimate: estimateTokens });
    const blockedRules = sel.blocked.filter((b) => b.kind === "rule");
    expect(blockedRules.length).toBeGreaterThan(0);
    // 成因应是 over-group-cap (规则组配额用尽) —— 而不是条目本身太大
    expect(blockedRules.some((b) => b.reason === "over-group-cap")).toBe(true);
    // 且"被挡的"确实不在选中里
    for (const b of sel.blocked) expect(sel.entries.some((e) => e.id === b.id)).toBe(false);
  });

  it("**校验承诺**: 若所有规则都能进, blocked 里不该有规则", () => {
    const rules = Array.from({ length: 3 }, (_, i) => rule("r" + i, "短规则 " + i));
    const sel = selectAlwaysOnDetailed(rules, { budgetTokens: 400, estimate: estimateTokens });
    expect(sel.blocked.filter((b) => b.kind === "rule")).toHaveLength(0);
    expect(sel.entries).toHaveLength(3);
  });

  it("两出口**结果一致** (共用同一实现, 无口径分叉)", () => {
    const rules = Array.from({ length: 9 }, (_, i) => rule("r" + i, "规则 " + i + " " + "说明".repeat(8)));
    const a = selectAlwaysOn(rules, { budgetTokens: 400, estimate: estimateTokens });
    const b = selectAlwaysOnDetailed(rules, { budgetTokens: 400, estimate: estimateTokens });
    expect(b.entries).toEqual(a);
  });

  it("被挡的条目**永远不出现在选中里** (报告与结果自洽)", () => {
    const rules = Array.from({ length: 9 }, (_, i) => rule("r" + i, "规则 " + i + " " + "说明".repeat(8)));
    const sel = selectAlwaysOnDetailed(rules, { budgetTokens: 400, estimate: estimateTokens });
    const selected = new Set(sel.entries.map((e) => e.id));
    const blocked = new Set(sel.blocked.map((b) => b.id));
    for (const id of blocked) expect(selected.has(id)).toBe(false);
  });
});

describe("条数闸 (maxEntries): 注意力成本与预算成本是两个正交约束", () => {
  // 为什么需要它 (2026-09-29, 用户实测 "太多无用上下文"): token 预算只管"总长度" ——
  // 9 条短规则能轻松塞进 400 token, 却各自占用注意力。实测真实首轮注入 9 条/581 token,
  // 其中 41% 是包装。业界同族做法是文件级行数上限 (Claude Code 200 行 / Cursor 500 行),
  // 同样不是纯字节闸。本组用例钉住: 条数能单独成为约束, 且被挡的有记录、可解释。
  const short = (id: string) => rule(id, "短规则" + id);

  it("预算充足但条数上限 = 3 → 只选分数最高的 3 条", () => {
    const rules = [short("a"), short("b"), short("c"), short("d"), short("e")];
    const sel = selectAlwaysOnDetailed(rules, {
      budgetTokens: 10000, // 预算故意开到极大: 唯一变量是条数
      maxEntries: 3,
      estimate: estimateTokens,
    });
    expect(sel.entries).toHaveLength(3);
  });

  it("被条数挡掉的条目进 blocked 且 reason = over-entry-cap (面板要能解释)", () => {
    const rules = [short("a"), short("b"), short("c"), short("d")];
    const sel = selectAlwaysOnDetailed(rules, { budgetTokens: 10000, maxEntries: 2, estimate: estimateTokens });
    expect(sel.entries).toHaveLength(2);
    const blocked = sel.blocked.filter((b) => b.reason === "over-entry-cap");
    expect(blocked.length).toBe(2);
    // 被挡的必须是**没被选中**的那几条 (不能同时出现在 selected 与 blocked —— 面板的自洽前提)。
    const selectedIds = new Set(sel.entries.map((e) => e.id));
    for (const b of blocked) expect(selectedIds.has(b.id), b.id + " 不应同时被选中与被挡").toBe(false);
    // content 必须带上, 否则面板只能显示"被挡了"却看不出挡的是哪条 (2026-09-18 修过同类空串缺陷)。
    for (const b of blocked) expect(b.content.length).toBeGreaterThan(0);
  });

  it("选取是确定性的: 同样输入两次得到同一集合 (不依赖数组次序)", () => {
    const rules = [short("a"), short("b"), short("c"), short("d")];
    const sel1 = selectAlwaysOnDetailed(rules, { budgetTokens: 10000, maxEntries: 2, estimate: estimateTokens });
    const sel2 = selectAlwaysOnDetailed([...rules].reverse(), { budgetTokens: 10000, maxEntries: 2, estimate: estimateTokens });
    expect(sel1.entries.map((e) => e.id).sort()).toEqual(sel2.entries.map((e) => e.id).sort());
  });

  it("不传 maxEntries → 不限制 (老调用点行为一字不变)", () => {
    const rules = Array.from({ length: 8 }, (_, i) => short("r" + i));
    const sel = selectAlwaysOnDetailed(rules, { budgetTokens: 10000, estimate: estimateTokens });
    expect(sel.entries).toHaveLength(8);
    expect(sel.blocked.filter((b) => b.reason === "over-entry-cap")).toEqual([]);
  });

  it("两种闸同时开着时, 各自记自己的 reason (排查方向不被带偏)", () => {
    // 构造: 预算够放 3 条短规则, 但条数限 1; 外加一条**超长**规则 (预算根本放不下)。
    // 期望: 选中的是被条数允许的第一条; 超长那条被挡的原因是**预算**而不是条数 ——
    // 两者的处置不同 (放宽条数 vs 放宽预算), 记错会把人引向错误的修法。
    const tiny = (id: string) => rule(id, "短" + id);
    const huge = rule("huge", "超长规则" + "填充".repeat(200));
    const sel = selectAlwaysOnDetailed([tiny("a"), huge, tiny("b")], {
      budgetTokens: 60,
      maxEntries: 1,
      estimate: estimateTokens,
    });
    expect(sel.entries).toHaveLength(1);
    const hugeBlocked = sel.blocked.find((b) => b.id === "huge");
    expect(hugeBlocked, "超长条目必须出现在 blocked 里").toBeTruthy();
    expect(hugeBlocked!.reason, "超长的成因是预算, 不是条数").toBe("over-total-budget");
    // 而被条数挡掉的那条, reason 必须是 over-entry-cap。
    const byCap = sel.blocked.filter((b) => b.reason === "over-entry-cap");
    expect(byCap.length).toBeGreaterThan(0);
  });
});
