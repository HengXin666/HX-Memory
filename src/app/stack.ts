// app/stack.ts — 组装一份可用的记忆栈 (CLI / MCP / 脚本 / 测试共用)。
//
// 为什么要有它: 组装顺序 (真相 → 索引 → 检索 → Facade → 重建) 与"哪个能力挂在哪"是易错点
// (例如 Facade 必须拿到检索器, 重建服务必须拿到 episode 日志)。集中一处, 各处复用。
import { FileBackend } from "../storage/file-store.ts";
import { EpisodeStore } from "../storage/episode-store.ts";
import { HybridRetriever } from "../retrieval/hybrid.ts";
import { DEFAULT_CHANNEL_WEIGHTS } from "../retrieval/tuning.ts";
import type { Channel } from "../kernel/ports.ts";
import { LexicalEmbedder } from "../retrieval/embedding-lexical.ts";
import { LinearVectorIndex } from "../retrieval/vector.ts";
import { ProjectedVectorIndex } from "../retrieval/vector-projected.ts";
import { openAiEmbedderFromEnv } from "../retrieval/embedding-http.ts";
import { asSyncEmbedder, type Embedder } from "../kernel/ports.ts";
import { MemoryFacade } from "./facade.ts";
import { RebuildService } from "./rebuild.ts";
import { ConsolidationService } from "./consolidate.ts";
import { MemoryNormalizer } from "./normalize.ts";

export interface MemoryStack {
  store: FileBackend;
  episodes: EpisodeStore;
  retriever: HybridRetriever;
  facade: MemoryFacade;
  rebuild: RebuildService;
  consolidate: ConsolidationService;
  /** 主动整理 / 无损迁移 (形态规范化; dryRun 可先看清单)。 */
  normalize: MemoryNormalizer;
  close(): void;
}

export interface OpenMemoryOptions {
  /** episode 保留天数 (0 = 永久); 只影响 prune, 不影响捕获。 */
  episodeRetentionDays?: number;
  /** 可注入时钟 (测试确定性)。 */
  now?: () => string;
  /**
   * 嵌入器。默认: 配了 HX_MEMORY_EMBEDDING_BASE_URL/MODEL 用远端真语义 (异步+投影),
   * 否则用本地 LexicalEmbedder (离线语义近似, 零依赖)。传 null 完全关闭语义通道。
   */
  embedder?: Embedder | null;
  /** 关闭自动演化 (取代/冲突标记)。 */
  autoEvolve?: boolean;
  /** 实体通道进榜上限 (见 HybridRetriever 的标定说明)。 */
  entityMaxIds?: number;
  /** 实体通道的共享实体门槛。 */
  entityMinShared?: number;
  /** 实体候选的出口: "tier2" (默认) 或 "main"。 */
  entityMode?: "main" | "tier2";
  /** tier2 模式下实体候选的配额。 */
  entityQuota?: number;
  /**
   * 通道权重覆盖 (与 DEFAULT_CHANNEL_WEIGHTS 合并; 缺省用默认表)。
   *
   * ⚠ 2026-09-18 补 (实测缺口): 此参数此前**只存在于 HybridRetriever 的构造参数里**,
   * 而所有生产路径都经 openMemoryStack 组装 —— 不透传等于"权重永远无法调整"。
   * 后果实测: 我扫描 bm25 权重 1→12、以及四种极端配置 (0.01 / 1000), **top1 完全相同** ——
   * 整个实验无效, 且差点被误读成"权重对结果无影响"。
   * 与 entityMaxIds/entityMode 是同一类缺口 (那三项此前补过一次, 见下方注释)。
   */
  channelWeights?: Partial<Record<Channel, number>>;
  /**
   * 以下检索标定项此前**只在 HybridRetriever 构造参数里**, 未经 openMemoryStack 透传 ——
   * 与 channelWeights 是同一类缺口 (2026-09-18 实测: 不透传的参数做实验会得到
   * "所有配置读数完全相同"的假象, 而这极易被误读成"该参数无影响")。
   * 它们全部影响检索指标, 因此必须可配, 否则"评测变体"与"生产默认"无法对照。
   */
  /** 每通道取多少候选进融合 (默认按 limit 推导)。 */
  channelLimit?: number;
  /** 覆盖率下限 (0..1): 低于它且命中词数不足的候选被丢弃。 */
  coverageFloor?: number;
  /** 图扩展跳数。 */
  graphHops?: 0 | 1 | 2;
  /** 图候选的独立配额 (第二梯队条数)。 */
  graphTierQuota?: number;
  /** RRF 的 k 值 (默认 60)。 */
  rrfK?: number;
  /** MMR 的 lambda (0..1; 1 = 纯相关性, 越小越强调多样性)。 */
  mmrLambda?: number;
}

export function openMemoryStack(root: string, opts: OpenMemoryOptions = {}): MemoryStack {
  const store = new FileBackend({ root });
  const episodes = new EpisodeStore({
    root,
    ...(opts.episodeRetentionDays === undefined
      ? {}
      : { retentionDays: opts.episodeRetentionDays }),
  });
  // 向量通道: 两种嵌入器两条路 ——
  //   同步 (本地哈希/常驻 ONNX) → LinearVectorIndex, 预步直接可用;
  //   异步 (远端 OpenAI 兼容端点) → ProjectedVectorIndex, 后台补齐、预步读投影 (ADR-025)。
  const embedder =
    opts.embedder === null
      ? undefined
      : (opts.embedder ?? openAiEmbedderFromEnv() ?? new LexicalEmbedder());
  const syncEmbedder = embedder ? asSyncEmbedder(embedder) : null;
  const vectorIndex = !embedder
    ? undefined
    : syncEmbedder
      ? new LinearVectorIndex({ embedder: syncEmbedder })
      : new ProjectedVectorIndex({ embedder });
  // 词面通道权重 2: 实测 (166 case) 词面在精度上稳定强于向量, 而向量在同义改写上补召回;
  // 让词面主导的配比在 R@1/R@10 上同时优于等权。见 docs/memory-benchmark-report.md。
  const retriever = new HybridRetriever(store, {
    // 权重表来自 retrieval/tuning.ts (单一事实源): 评测变体与线上组装必须是同一份默认值,
    // 否则"评测里生效的配比"与"用户实际拿到的"会悄悄分叉。
    // 默认表 + 覆盖合并 (而不是直接替换) —— 调用方只想调 bm25 时不该丢掉其余默认值。
    channelWeights: { ...DEFAULT_CHANNEL_WEIGHTS, ...(opts.channelWeights ?? {}) },
    ...(opts.channelLimit === undefined ? {} : { channelLimit: opts.channelLimit }),
    ...(opts.coverageFloor === undefined ? {} : { coverageFloor: opts.coverageFloor }),
    ...(opts.graphHops === undefined ? {} : { graphHops: opts.graphHops }),
    ...(opts.graphTierQuota === undefined ? {} : { graphTierQuota: opts.graphTierQuota }),
    ...(opts.rrfK === undefined ? {} : { rrfK: opts.rrfK }),
    ...(opts.mmrLambda === undefined ? {} : { mmrLambda: opts.mmrLambda }),
    ...(vectorIndex ? { vectorIndex } : {}),
    // 实体通道的标定项必须**从这里透传**: 它们此前只存在于检索器的构造参数里,
    // 而所有生产路径都经 openMemoryStack 组装 —— 不透传等于这些设置永远不生效
    // (实测踩到: 扫描多组配置得到完全相同的读数, 因为每一组都跑的是默认值)。
    ...(opts.entityMaxIds === undefined ? {} : { entityMaxIds: opts.entityMaxIds }),
    ...(opts.entityMinShared === undefined ? {} : { entityMinShared: opts.entityMinShared }),
    ...(opts.entityMode === undefined ? {} : { entityMode: opts.entityMode }),
    ...(opts.entityQuota === undefined ? {} : { entityQuota: opts.entityQuota }),
  });
  const facade = new MemoryFacade(
    { store, retriever },
    {
      ...(opts.now ? { now: opts.now } : {}),
      ...(embedder ? { embedder } : {}),
      ...(opts.autoEvolve === undefined ? {} : { autoEvolve: opts.autoEvolve }),
    },
  );
  // 让 stats() 带上引擎状态 (索引可用性/降级原因) —— 面板与 CLI 都靠它判断"检索是不是降级了"。
  facade.withIndexStatus(() => store.ftsStatus());
  // 接入 episode 原文源: 使"证据链"可下钻 (条目 → 产生它的那轮对话原文)。
  // 没有这一跳, derivedFrom 里存的 id 就永远换不回原话 —— 产品承诺的"可溯源"不可执行。
  facade.withEvidence(episodes);
  const rebuild = new RebuildService({ store, episodes });
  const consolidate = new ConsolidationService({ store, ...(opts.now ? { now: opts.now } : {}) });
  const normalize = new MemoryNormalizer(store, root);
  return {
    store,
    episodes,
    retriever,
    facade,
    rebuild,
    consolidate,
    normalize,
    close: () => store.close(),
  };
}
