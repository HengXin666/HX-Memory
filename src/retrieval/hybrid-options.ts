// retrieval/hybrid-options.ts — HybridRetriever 的构造选项 (2026-11-02 从 hybrid.ts 拆出, verify-structure 400 行约束; hybrid.ts re-export)。
import type { Channel, RetrievalCapabilities, VectorIndex } from "../kernel/ports.ts";

/**
 * 图候选降为第二梯队 (补位不抢占)
 * .agents/notes/implemented/architecture/2026-09-12-graph-as-second-tier.md
 * 检索返回顺序必须按综合分降序 (修 MMR 顺序被当排名的缺陷)
 * .agents/notes/implemented/bug-fix/2026-09-12-retrieval-order-not-mmr-order.md
 * 实体抽取接入写入路径 (entities 从 0% 到可用)
 * .agents/notes/implemented/feature/2026-09-12-entity-extraction-and-linking.md
 * 实体反查 (把 actions/02 的行动项 1 落到检索期)
 * .agents/notes/implemented/feature/2026-09-13-entity-reverse-lookup.md
 */
export interface HybridRetrieverOptions {
  /** 每个通道的候选数 (再融合)。 */
  channelLimit?: number;
  /**
   * 各通道的 RRF 权重默认值 (缺省 1)。
   *
   * 为什么需要: RRF 只吃排名, 通道之间"谁更该说了算"只能靠权重表达。
   * 实测 (166 个 case, 见 docs/memory-benchmark-report.md): bm25 权重 2 时词面精度最好,
   * 而向量通道的候选没有覆盖率门槛、又常常在同义改写上补召回 
   * 让词面占主导、向量做补充的配比明显优于等权。
   */
  channelWeights?: Partial<Record<Channel, number>>;
  /** 覆盖率下限 (0..1): 低于它且命中词数不足的候选被丢弃 (压 bigram 噪声)。 */
  coverageFloor?: number;
  /** 图扩展的默认跳数。 */
  graphHops?: 0 | 1 | 2;
  /**
   * 图候选的独立配额 (第二梯队条数; 默认 3, 0 = 不追加)。
   *
   * 为什么是配额而不是权重: 图候选是"主题邻居"不是"答案" (实测 gold 精确率 8.5%),
   * 按权重参与 RRF 会挤掉词面命中; 但它在字面不可达时确实有用。配额让它"只能补位,
   * 不能抢占"  实测同时保住 R@1 (0.684) 与图专属召回 (0.25 -> 0.75)。
   */
  graphTierQuota?: number;
  rrfK?: number;
  mmrLambda?: number;
  /** 时钟 (测试可注入)。 */
  now?: () => string;
  capabilities?: RetrievalCapabilities;
  /** 向量索引 (有则启用语义召回通道; 实现可换 sqlite-vec/LanceDB/Qdrant)。 */
  vectorIndex?: VectorIndex;
  /** 实体通道进榜上限 (默认 DEFAULT_ENTITY_MAX_IDS)。 */
  entityMaxIds?: number;
  /** 实体通道的共享实体门槛 (默认 DEFAULT_ENTITY_MIN_SHARED)。 */
  entityMinShared?: number;
  /** 实体候选的出口: "tier2" (独立配额的尾巴, 默认) 或 "main" (与词面竞争主排序)。 */
  entityMode?: "main" | "tier2";
  /** 走 tier2 时给实体候选的配额 (默认 DEFAULT_ENTITY_QUOTA)。 */
  entityQuota?: number;
}
