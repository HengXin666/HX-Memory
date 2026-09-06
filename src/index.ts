// HX-Memory public entry. Kernel + 纯服务 (capture/recall/generalize) 无 harness 依赖可直达。
// adapters (dsh/codex) 与 storage 具体实现可插拔, 经子路径导入: @hx/hx-memory/dsh, ./storage/file-store.ts
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
export { clusterByTheme, themeOf, type ThemeCluster } from "./generalize/cluster.ts";
export {
  GeneralizerService,
  type QueuedProposal,
  type ProposalStatus,
  type Abstractor,
} from "./generalize/service.ts";
