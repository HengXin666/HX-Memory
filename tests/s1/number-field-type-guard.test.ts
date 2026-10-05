// tests/s1/number-field-type-guard.test.ts — `numberField` 必须**拒收布尔值**。
//
// 为什么需要它 (2026-09-18, §768 实测): 上一轮给 `StructuredTurn` 加了 `importance`/`confidence` ——
// 它们由 **LLM** 产出, 而 LLM 的 JSON 里 `true`/`false` 是常见的坏输出。
//
// 旧实现的路径:
//
// ```ts
// const n = typeof value === "number" ? value : Number(value);   // Number(true) === 1
// return Math.min(max, Math.max(min, n));                        // clamp 到 1 —— 合法区间内!
// ```
//
// **⇒ `{"importance": true}` 静默落成 `importance = 1`, 而 1 表示"**最不重要**"** ——
// 语义**完全相反**, 且**无任何告警**。`false` 同样落成 1。
//
// ⚠ 而**字符串数字 `"9"` 必须继续被接受**: 那是 LLM 的**表示差异**而非语义错误,
// 拒收它会让本该成功的写入失败。判据是"**有没有确定的数值含义**", 不是"类型是否 strict"。
import { describe, expect, it } from "vitest";
import { numberField } from "../../src/storage/entry-normalize.ts";

describe("numberField: 类型守卫", () => {
  it("**拒收 boolean** (它在 importance 的合法区间内 ⇒ 会静默落成'最不重要')", () => {
    expect(() => numberField(true, "importance", 1, 10)).toThrow(/invalid importance/);
    expect(() => numberField(false, "importance", 1, 10)).toThrow(/invalid importance/);
    // confidence 同理: Number(true)=1 落在 [0,1] 的上界 ⇒ "最自信"。
    expect(() => numberField(true, "confidence", 0, 1)).toThrow(/invalid confidence/);
  });

  it("### 负例: **字符串数字仍必须接受** (LLM 的表示差异, 不是语义错误)", () => {
    expect(numberField("9", "importance", 1, 10)).toBe(9);
    expect(numberField("0.42", "confidence", 0, 1)).toBeCloseTo(0.42);
  });

  it("### 负例: **正常数字与越界 clamp 行为不变** (不因加守卫而改语义)", () => {
    expect(numberField(9, "importance", 1, 10)).toBe(9);
    expect(numberField(99, "importance", 1, 10)).toBe(10); // clamp 上界
    expect(numberField(-5, "importance", 1, 10)).toBe(1); // clamp 下界
    expect(numberField(undefined, "importance", 1, 10)).toBeUndefined();
    expect(numberField(null, "importance", 1, 10)).toBeUndefined();
  });

  it("### 负例: **非数值字符串仍抛错** (既有行为)", () => {
    expect(() => numberField("abc", "importance", 1, 10)).toThrow(/invalid importance/);
    expect(() => numberField(Number.NaN, "importance", 1, 10)).toThrow(/invalid importance/);
  });
});
