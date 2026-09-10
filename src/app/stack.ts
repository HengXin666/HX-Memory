// app/stack.ts — 组装一份可用的记忆栈 (CLI / MCP / 脚本 / 测试共用)。
//
// 为什么要有它: 组装顺序 (真相 → 索引 → 检索 → Facade → 重建) 与"哪个能力挂在哪"是易错点
// (例如 Facade 必须拿到检索器, 重建服务必须拿到 episode 日志)。集中一处, 各处复用。
import { FileBackend } from "../storage/file-store.ts";
import { EpisodeStore } from "../storage/episode-store.ts";
import { HybridRetriever } from "../retrieval/hybrid.ts";
import { HashingEmbedder } from "../retrieval/embedding.ts";
import { LinearVectorIndex } from "../retrieval/vector.ts";
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
  /** 嵌入器 (默认本地 HashingEmbedder: 零依赖零成本)。传 null 关闭语义兜底。 */
  embedder?: Embedder | null;
  /** 关闭自动演化 (取代/冲突标记)。 */
  autoEvolve?: boolean;
}

export function openMemoryStack(root: string, opts: OpenMemoryOptions = {}): MemoryStack {
  const store = new FileBackend({ root });
  const episodes = new EpisodeStore({
    root,
    ...(opts.episodeRetentionDays === undefined ? {} : { retentionDays: opts.episodeRetentionDays }),
  });
  // 向量通道: 只有**同步**嵌入器才能进预步注入路径 (异步的要走投影, 见 architecture-v2 §3.3)。
  const embedder = opts.embedder === null ? undefined : (opts.embedder ?? new HashingEmbedder());
  const syncEmbedder = embedder ? asSyncEmbedder(embedder) : null;
  const vectorIndex = syncEmbedder ? new LinearVectorIndex({ embedder: syncEmbedder }) : undefined;
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
