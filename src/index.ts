// HX-Memory public entry. Kernel + 纯服务 (capture/recall/generalize) 无 harness 依赖可直达。
// adapters (dsh/codex) 与 storage 具体实现可插拔, 经子路径导入: @hengxin666/hx-memory/dsh, ./storage/file-store.ts
export type * from "./kernel/types.ts";
export type * from "./kernel/ports.ts";
export { expandEvolutionChain, sliceAt } from "./kernel/evolution.ts";
export {
  captureTurn,
  nowIso,
  type TurnInput,
  type CaptureOptions,
  type CaptureResult,
} from "./capture/engine.ts";
export { CapturePipeline } from "./capture/pipeline.ts";
export { RecallService, type RecallInput, type RecallOutput } from "./recall/service.ts";
export {
  MemoryFacade,
  formatRetrieval,
  type FacadeStore,
  type RememberInput,
  type RememberResult,
  type RememberDecision,
  type RecallResponse,
  type MemoryStats,
} from "./app/facade.ts";
export { decideAssociation, normalizeFingerprint } from "./evolution/associate.ts";
export { EpisodeStore, EPISODES_DIR, asEpisode } from "./storage/episode-store.ts";
export { MemoryBackend } from "./storage/memory-store.ts";
export {
  ConsolidationService,
  DEFAULT_EXPIRABLE_KINDS,
  type ConsolidateReport,
  type ConsolidateOptions,
} from "./app/consolidate.ts";
export { openMemoryStack, type MemoryStack, type OpenMemoryOptions } from "./app/stack.ts";
export {
  RebuildService,
  captureExtractor,
  asRebuildable,
  type RebuildReport,
  type RebuildLevel,
  type EpisodeExtractor,
} from "./app/rebuild.ts";
export { HybridRetriever, type HybridRetrieverOptions } from "./retrieval/hybrid.ts";
export { clusterByTheme, themeOf, type ThemeCluster } from "./generalize/cluster.ts";
export {
  GeneralizerService,
  type QueuedProposal,
  type ProposalStatus,
  type Abstractor,
} from "./generalize/service.ts";

/** No-op cordis plugin face (对齐 ReMe): DSH 的 patch group 会在服务端加载根入口,
 *  根入口必须是一个合法的 cordis plugin (有 apply)。真实功能在 ./dsh; 真实 Web UI 在 ./client
 *  (由宿主按 dsh.client 元数据加载)。 */
export function apply(): void {}
