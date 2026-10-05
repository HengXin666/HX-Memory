// tests/s1/capabilities-default.test.ts — 保守默认的能力自述必须有测试钉住。
//
// 为什么需要它 (2026-09-18 变异测试发现): 把 `DEFAULT_CAPS.multiProcess` 从 false 翻成 true,
// **全量测试通过** —— 即 `DEFAULT_CAPS` **没有任何测试保护**。
//
// ⚠ 顺带纠正一处注释与事实不符: `capabilities.ts` 的注释写"数值与原实现逐字一致
// (它同时被 conformance 断言)" —— **核实后发现没有任何测试引用 `DEFAULT_CAPS`**。
// 本文件让那句话成真。
//
// 为什么这个对象值得保护 (而不是"反正真实装配走不到"):
//   · 它是**最后一道兜底** (优先级: 显式配置 > 引擎自述 > 保守默认);
//   · 真实装配下它不被走到 (实测 caps 来自 index-status.ts 的 source.capabilities()),
//     **恰恰因此**它一旦被改坏会**静默生效**: 没有测试、没有运行时路径会告诉你它变了,
//     直到某个没有 capabilities 方法的适配器接进来;
//   · 而它的内容是一句**诚实性声明** —— `semantic: false` 的意思正是"没有 embedding 通道
//     就不要宣称语义检索" (见该文件头注释), 这与`multiProcess: false` 是同一类承诺。
import { describe, expect, it } from "vitest";
import { DEFAULT_CAPS, negotiateCapabilities } from "../../src/retrieval/capabilities.ts";
import type { RetrievalCapabilities } from "../../src/kernel/ports.ts";

describe("能力的保守默认 (兜底路径)", () => {
  it("**不宣称任何它没有的能力** (诚实性)", () => {
    // engine 为 unknown 是刻意的: 我们确实不知道底层是什么。
    expect(DEFAULT_CAPS.engine).toBe("unknown");
    // semantic: false —— 没有 embedder 就不许宣称语义检索。
    expect(DEFAULT_CAPS.semantic).toBe(false);
    // multiProcess: false —— 进程边界内的存储不该声称可跨进程共享。
    expect(DEFAULT_CAPS.multiProcess).toBe(false);
  });

  it("字面量能力与 graph 类型 (graph 是联合字面量而非布尔)", () => {
    expect(DEFAULT_CAPS.fullText).toBe(true);
    expect(DEFAULT_CAPS.cjk).toBe(true);
    expect(DEFAULT_CAPS.graph).toBe("relations");
  });

  it("**优先级: 显式配置 > 引擎自述 > 保守默认** (兜底只在两者都缺时生效)", () => {
    const declared: RetrievalCapabilities = {
      engine: "sqlite-fts5", fullText: true, cjk: true, semantic: false,
      graph: "relations", multiProcess: true,
    };
    // 引擎自述存在 ⇒ 用它, 不用默认
    expect(negotiateCapabilities({}, { capabilities: () => declared })).toEqual(declared);
    // 显式配置存在 ⇒ 用它
    const explicit: RetrievalCapabilities = { ...declared, engine: "custom" };
    expect(negotiateCapabilities({ capabilities: explicit }, { capabilities: () => declared }).engine).toBe("custom");
    // 两者都缺 ⇒ 落到保守默认
    expect(negotiateCapabilities({}, {})).toEqual(DEFAULT_CAPS);
  });

  it("vectorIndex 存在但没显式 capabilities 时补 semantic 并标注 +vec", () => {
    // 这条是"向量索引的存在本身就是语义能力的证据"的落实。
    const out = negotiateCapabilities({ vectorIndex: {} }, { capabilities: () => DEFAULT_CAPS });
    expect(out.semantic).toBe(true);
    expect(out.engine).toBe("unknown+vec");
  });
});
