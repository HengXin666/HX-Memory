// src/retrieval/capabilities.ts — 能力协商: 引擎自述与真实行为的对齐。
//
// 为什么独立成文件 (2026-09-18): 它是**装配期的一次性推导** (显式配置 > 引擎自述 > 保守默认),
// 与检索主流程无关; 内联在 HybridRetriever 构造函数里既占行数, 也让这条规则的优先级
// 只能通过构造一个检索器来间接测试。
//
// 铁律: 能力自述必须与**真实行为**一致 —— 宁可少宣称能力 (调用方会走降级路径),
// 也不要谎报 (调用方会以为有语义通道而拿到错误的空结果)。conformance 会断言这条。
import type { RetrievalCapabilities } from "../kernel/ports.ts";

/**
 * 保守默认: 什么都没配、引擎也没自述时的能力自述。
 *
 * 数值与原实现**逐字一致** —— 抽取时不得顺手"改进"它。
 *
 * ⚠ 2026-09-18 更正: 此处原写"它同时被 conformance 断言", 但**核实后发现没有任何测试引用它**
 * (变异 `multiProcess: false → true` 曾让全量测试通过)。现已由
 * `tests/s1/capabilities-default.test.ts` 真正钉住 —— 那句话现在成真了。
 *
 * 为什么它值得保护: 真实装配下这条兜底**走不到** (caps 来自 `index-status.ts` 的自述),
 * **恰恰因此**改坏它会静默生效 —— 没有测试、没有运行时路径会告诉你它变了。
 * 注意 graph 的类型是联合字面量而非布尔 ("none" | "relations"), 与 entity 能力无关。
 */
export const DEFAULT_CAPS: RetrievalCapabilities = {
  engine: "unknown",
  fullText: true,
  cjk: true,
  semantic: false,
  graph: "relations",
  multiProcess: false,
};

/**
 * 推导最终能力集。
 *
 * 优先级: 显式配置 > 引擎自述 > 保守默认。
 * 特例: 传了 vectorIndex 但没有显式 capabilities 时, 补上 semantic 并在引擎名后标注 "+vec"
 * (向量索引的存在本身就是语义能力的证据)。
 */
export function negotiateCapabilities(
  opts: { capabilities?: RetrievalCapabilities; vectorIndex?: unknown },
  source: { capabilities?: () => RetrievalCapabilities },
): RetrievalCapabilities {
  const declared = opts.capabilities ?? source.capabilities?.() ?? DEFAULT_CAPS;
  return opts.vectorIndex && !opts.capabilities
    ? { ...declared, semantic: true, engine: declared.engine + "+vec" }
    : declared;
}
