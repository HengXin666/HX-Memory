// app/stack.ts — 组装一份可用的记忆栈 (CLI / MCP / 脚本 / 测试共用)。
//
// 为什么要有它: 组装顺序 (真相 → 索引 → 检索 → Facade → 重建) 与"哪个能力挂在哪"是易错点
// (例如 Facade 必须拿到检索器, 重建服务必须拿到 episode 日志)。集中一处, 各处复用。
import { FileBackend } from "../storage/file-store.ts";
import { EpisodeStore } from "../storage/episode-store.ts";
import { HybridRetriever } from "../retrieval/hybrid.ts";
import { LexicalEmbedder } from "../retrieval/embedding-lexical.ts";
import { LinearVectorIndex } from "../retrieval/vector.ts";
import { ProjectedVectorIndex } from "../retrieval/vector-projected.ts";
import { openAiEmbedderFromEnv } from "../retrieval/embedding-http.ts";
import { asSyncEmbedder, type Embedder } from "../kernel/ports.ts";
import { MemoryFacade } from "./facade.ts";
import { RebuildService } from "./rebuild.ts";
import { ConsolidationService } from "./consolidate.ts";

export interface MemoryStack {
  store: FileBackend;
  episodes: EpisodeStore;
  retriever: HybridRetriever;
  facade: MemoryFacade;
  rebuild: RebuildService;
  consolidate: ConsolidationService;
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
  const retriever = new HybridRetriever(store, vectorIndex ? { vectorIndex } : {});
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
  const rebuild = new RebuildService({ store, episodes });
  const consolidate = new ConsolidationService({ store, ...(opts.now ? { now: opts.now } : {}) });
  return {
    store,
    episodes,
    retriever,
    facade,
    rebuild,
    consolidate,
    close: () => store.close(),
  };
}
