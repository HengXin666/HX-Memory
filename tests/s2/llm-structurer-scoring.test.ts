// tests/s2/llm-structurer-scoring.test.ts — **LLM 实现**必须真的产出 `importance`/`confidence`。
//
// 为什么需要它 (2026-09-18, §792 实测): §765 给 `StructuredTurn` 加了这两个字段、改了提示词,
// **却忘了在 `makeLlmStructurer` 的 return 里接上** —— 于是字段**仍然永不产出** (真库 0/480)。
//
// **⇒ 那一刻我只测了 pipeline 的透传 (喂假 structurer), 而没测真实实现。**
// ⇒ 教训: 加字段时要沿**整条链**测一遍 —— 声明 / 提示词 / **实现** / 透传 / 入库, 少一环就白做。
import { describe, expect, it } from "vitest";
import { scoringFields } from "../../src/adapters/dsh/llm-structurer.ts";

describe("LLM 结构化器: 评分字段的安全取值", () => {
  it("**正常值透传** (importance 取整、confidence 原样)", () => {
    expect(scoringFields({ importance: 9, confidence: 0.42 })).toEqual({ importance: 9, confidence: 0.42 });
  });

  it("### 负例: **坏值被丢弃, 而不是抛错** (增强环节不该让整轮捕获失败)", () => {
    // 与 entry-normalize.numberField 的**有意不同**: 那里抛错 (写入闸门), 这里丢弃 (增强)。
    expect(() => scoringFields({ importance: "abc" as never })).not.toThrow();
    expect(scoringFields({ importance: "abc" as never })).toEqual({});
    expect(scoringFields({ confidence: Number.NaN })).toEqual({});
    // 布尔值不接受 (§768 同口径: Number(true)=1 会静默落成"最不重要")。
    expect(scoringFields({ importance: true as never })).toEqual({});
  });

  it("### 边界: **越界 clamp 而非丢弃**", () => {
    expect(scoringFields({ importance: 99 })).toEqual({ importance: 10 });
    expect(scoringFields({ importance: -5 })).toEqual({ importance: 1 });
    expect(scoringFields({ confidence: 5 })).toEqual({ confidence: 1 });
    expect(scoringFields({ confidence: -1 })).toEqual({ confidence: 0 });
  });

  it("### 边界: **数字字符串接受** (LLM 的表示差异), 而 importance 取整", () => {
    expect(scoringFields({ importance: "9" as never })).toEqual({ importance: 9 });
    expect(scoringFields({ confidence: "0.42" as never })).toEqual({ confidence: 0.42 });
    expect(scoringFields({ importance: 7.6 })).toEqual({ importance: 8 });
  });

  it("### 负例: **没给 ⇒ 一个字段都不出现** (缺省走中性常量)", () => {
    expect(scoringFields({})).toEqual({});
    // confidence=0 是**合法值** ⇒ 必须出现 (不能按真假值判断)。
    expect(scoringFields({ confidence: 0 })).toEqual({ confidence: 0 });
  });
});
