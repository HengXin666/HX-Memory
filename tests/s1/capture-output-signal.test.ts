// tests/s1/capture-output-signal.test.ts — 产出信号判据的**正向与负向**契约。
//
// 为什么必须有负例 (独立盲审 2026-09-18 指出: 此前 capture-conclusion.test.ts 只有 11 条
// 正向用例、0 条负例): 放宽入口判据必然引人"捡回噪声"的风险, 而只测正向等于只测收益不测代价。
// 本文件两类都测 —— 尤其是"该丢的仍丢"。
import { describe, expect, it } from "vitest";
import {
  hasSubstantiveOutput,
  MIN_OUTPUT_LENGTH,
  MIN_SIGNAL_KINDS,
} from "../../src/capture/output-signal.ts";
import { captureTurn } from "../../src/capture/engine.ts";

/** 构造一段"有实质产出"的回答 (含路径 + 根因, 满足两类信号且够长)。 */
function substantiveAnswer(): string {
  return (
    "已修复: 根因是 runtime.ts:280 在 turn/start 时只重置 messages 而没重置 answers, " +
    "导致跨轮串台。修复方式是在该处一并重置 answers。\n" +
    "验证: node dist/adapters/codex/cli.js evidence --id m123 返回 traceable=yes。".padEnd(320, " 补充说明。")
  );
}

describe("hasSubstantiveOutput: 正向 (真有产出)", () => {
  it("含文件路径 + 根因的长回答 → true", () => {
    expect(hasSubstantiveOutput(substantiveAnswer())).toBe(true);
  });

  it("含错误码与命令的回答 → true", () => {
    const a = ("报错 ERR_MODULE_NOT_FOUND, 复现命令是 pnpm run build。" +
      "端口 41067 起不来是因为 fallback 逻辑。").padEnd(320, " 说明。");
    expect(hasSubstantiveOutput(a)).toBe(true);
  });
});

describe("hasSubstantiveOutput: 负向 (无产出 → 不得放行)", () => {
  it("空回答 → false", () => {
    expect(hasSubstantiveOutput("")).toBe(false);
    expect(hasSubstantiveOutput(undefined)).toBe(false);
  });

  it("短回答 → false (低于长度下限)", () => {
    expect(hasSubstantiveOutput("好的, 已完成。")).toBe(false);
    expect(hasSubstantiveOutput("x".repeat(MIN_OUTPUT_LENGTH - 1))).toBe(false);
  });

  it("长但只有**单一**类信号 → false (要求 >= 2 类)", () => {
    // 只有错误码一类, 其余是废话填充
    const a = ("遇到了 500 错误。").padEnd(400, " 这是一段没有具体信息的填充文字。");
    expect(hasSubstantiveOutput(a)).toBe(false);
    expect(MIN_SIGNAL_KINDS).toBe(2);
  });

  it("**纯指令要求更高门槛** (不是一刀切拒绝)", () => {
    // 设计意图: 纯指令本身没有信息需求, 但它的回答**可能有**产出 —— 该不该记由
    // "这一轮产出了什么"决定, 不该由"用户那句话长什么样"决定 (那正是本模块要修正的原缺陷)。
    // 因此纯指令只把门槛从 2 类提到 3 类。
    const rich = substantiveAnswer(); // 含路径+根因+命令, 命中 >= 3 类
    expect(hasSubstantiveOutput(rich, "继续啊")).toBe(true);
    expect(hasSubstantiveOutput(rich, "next")).toBe(true);
    // 而只沾边两类信号的长回答, 配纯指令时被拦 (可能是"随口回了几句")
    const thin = ("根因是缓存。").padEnd(320, " 没有具体标识符的填充文字。") + " ERR_X";
    expect(hasSubstantiveOutput(thin, "继续啊")).toBe(false);
    expect(hasSubstantiveOutput(thin)).toBe(true); // 非纯指令时同内容放行
  });

  it("指令**含具体对象**时不拦 (不能一刀切)", () => {
    expect(hasSubstantiveOutput(substantiveAnswer(), "继续修那个 500 错误")).toBe(true);
  });
});

describe("性能门禁: 捕获路径是每轮同步执行的", () => {
  it("**超长文本不得触发 ReDoS** (原实现 10 万字符要 2.3 秒)", () => {
    // 自查发现的真缺陷 (2026-09-18): 文件路径正则用**无界量词** \w+ 导致回溯 ——
    // 实测 10 万字符 2289ms。真实数据里 assistant 回答最长 59037 字符, 属条件性风险。
    // 关键在"无界量词"而非嵌套: 原版 2293ms / 有 * 的版本 1849ms /
    // 只找扩展名 0ms / 前置词限定 {1,64} **14ms**。
    const big = "a".repeat(50_000) + " " + "b".repeat(50_000);
    const t0 = Date.now();
    hasSubstantiveOutput(big);
    const ms = Date.now() - t0;
    // 阈值给足余量 (13ms 实测 vs 200ms 上限), 但足以拦住 2 秒级的形态。
    expect(ms).toBeLessThan(200);
  });

  it("有界量词不损失真实匹配能力", () => {
    const text =
      "根因在 src/adapters/dsh/gateway.ts:368 的形参名与协议面不一致, 已改为 id。".padEnd(320, " 补充。");
    expect(hasSubstantiveOutput(text)).toBe(true);
  });
});

describe("captureTurn: 产出信号接入后的端到端行为", () => {
  it("短指令 + 有实质产出 → 进入候选 (不再因措辞被丢)", () => {
    const r = captureTurn({ session: "s", text: "next", answer: substantiveAnswer() }, {}, new Set());
    // 进入候选 = 不再返回 no-signal; 是否最终落盘由结构化器的结论闸门决定
    expect(r.signal).not.toContain("no-signal");
  });

  it("短指令 + 空产出 → 仍丢弃 (保持原行为)", () => {
    const r = captureTurn({ session: "s", text: "next", answer: "" }, {}, new Set());
    expect(r.entries).toHaveLength(0);
    expect(r.signal).toContain("no-signal");
  });

  it("无实质产出的闲聊 + 短指令 → 仍丢弃", () => {
    const r = captureTurn({ session: "s", text: "next", answer: "好的。" }, {}, new Set());
    expect(r.entries).toHaveLength(0);
  });
});
