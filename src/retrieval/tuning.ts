// retrieval/tuning.ts — 检索期的**标定常量** (全部是测出来的, 不是拍的)。
//
// 为什么单独一个文件: 这些数字的**变化原因**与检索算法完全不同 —— 算法随设计变,
// 常量随评测数据变。混在一起时, 改一个配额就要在 400 行的检索器里翻找, 而且很容易
// 只改了这里、忘了那边 (实测踩到过: 实体通道的四个参数只存在于检索器构造参数里,
// 而生产路径全部经 openMemoryStack 组装, 不透传 = 这些设置永远不生效, 而扫描多组配置
// 会得到完全相同的读数, 看起来像"参数没影响")。
//
// 每个常量都注明依据与**代价**, 因为它们的取值都来自"两头读数方向相反"的取舍。
import type { Channel } from "../kernel/ports.ts";

/**
 * 实体通道进榜上限 (tier2 模式下生效)。
 *
 * 依据 (80 条语料 / 171 主 case + 104 entity_only case; 确定性纯词面臂):
 *   上限 4 → entity_only H@10 0.144; 8 → 0.250; **16 → 0.2596 且此后不再增长** (候选池有界);
 *   主 case 在**所有**上限下都与关闭该通道逐位相同 (H@1 0.807 / H@10 0.9123) ——
 *   因为 tier2 只补位、不参与打分竞争。取 16 是因为收益在这里封顶, 不是因为"越大越多"。
 * 对照: 若把该通道放进主排序 (`entityMode: "main"`), 主 case H@1 掉到 0.503 —— 见下。
 */
export const DEFAULT_ENTITY_MAX_IDS = 16;

/** 共享实体门槛: 1 = 任意共享。实测 2 在 entity_only 上没有任何提升 (桥会因为强连接太少而断掉)。 */
export const DEFAULT_ENTITY_MIN_SHARED = 1;

/**
 * 实体候选的默认出口。
 *
 * "main" (与词面竞争主排序) 实测**两头都输**: entity_only H@10 0.106 (远低于 tier2 的 0.260),
 * 主 case H@1 0.807 → 0.5029、H@10 0.9123 → 0.8304。原因是实体候选与图候选同性质 ——
 * 是"主题邻居"而不是答案 (图候选的 gold 精确率实测只有 8.5%)。
 * 因此默认走独立配额的尾巴, 与图通道当初的修法一致 (R@1 0.684 vs 0.630 → 分层后两头都保住)。
 */
export const DEFAULT_ENTITY_MODE: "main" | "tier2" = "tier2";

/**
 * tier2 模式下实体候选的配额。
 *
 * 它与 graphTierQuota (3) 分开而不是共用一份: 两个通道的候选质量不同,
 * 合成一份配额会让一个通道的长列表把另一个挤掉 (assemble.ts 里按通道分别计数)。
 * 取值 8 是实测的**饱和点**: entity_only H@10 在配额 3 时 0.154、8 时 0.250、20 时仍是 0.250。
 */
export const DEFAULT_ENTITY_QUOTA = 8;

/** 词面通道的默认权重 (标定见 docs/memory-benchmark-report.md: 词面主导 + 语义补召回)。 */
export const DEFAULT_BM25_WEIGHT = 2;

/** 默认通道权重表 (生产组装与评测变体共用同一份, 避免"评测与线上不是同一套配置")。 */
export const DEFAULT_CHANNEL_WEIGHTS: Partial<Record<Channel, number>> = {
  bm25: DEFAULT_BM25_WEIGHT,
};
