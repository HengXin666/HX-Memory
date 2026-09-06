// src/adapters/dsh/gateway.ts — HX-Memory 的 DSH Web 远程服务 (Typert)。
// 暴露给前端 (dsh-client) 的只读+确认操作: review 队列浏览/确认/驳回 + 记忆检索。
// 保持薄: 所有逻辑在 GeneralizerService / FileBackend, 这里只做 RPC 投影。
import type { Context } from "@deepseek-ai/cordis";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import type { FileBackend } from "../../storage/file-store.ts";
import type {
  GeneralizerService,
  ProposalStatus,
  QueuedProposal,
} from "../../generalize/service.ts";

/** Gateway 依赖的最小端口 (可插拔: 便于测试注入, 也便于换实现)。 */
export interface HxMemoryGatewayDeps {
  store: FileBackend;
  generalizer: Pick<GeneralizerService, "listQueue" | "confirm" | "reject" | "runBatch">;
}

export interface ReviewQueueView {
  id: string;
  status: ProposalStatus;
  rule: string;
  covers: number;
  confidence: number;
  sourceRun: string;
  generatedAt: string;
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    /** HX-Memory review gateway mounted by the DSH adapter. */
    hxMemory: HxMemoryGateway;
  }
}

export class HxMemoryGateway extends TypertRemoteService {
  constructor(
    ctx: Context,
    private readonly deps: HxMemoryGatewayDeps,
  ) {
    super(ctx, "hxMemory");
  }

  @Remote("reviewQueue")
  reviewQueue(status?: ProposalStatus): ReviewQueueView[] {
    return this.deps.generalizer.listQueue(status).map(toView);
  }

  @Remote("confirmProposal")
  confirmProposal(id: string, by: string): { ok: boolean; ruleId?: string; error?: string } {
    return this.deps.generalizer.confirm(id, by);
  }

  @Remote("rejectProposal")
  rejectProposal(id: string): { ok: boolean } {
    this.deps.generalizer.reject(id);
    return { ok: true };
  }

  @Remote("memoryQuery")
  memoryQuery(q: { text?: string; kind?: string; limit?: number }): unknown[] {
    const hits = this.deps.store.query({
      text: q.text,
      kind: q.kind as never,
      limit: q.limit,
    });
    return hits.map((e) => ({
      id: e.id,
      kind: e.kind,
      content: e.content,
      scope: e.scope,
      source: e.source,
      confirmedBy: e.confirmedBy,
      confirmedAt: e.confirmedAt,
      validAt: e.ts.validAt,
    }));
  }
}

function toView(p: QueuedProposal): ReviewQueueView {
  return {
    id: p.id,
    status: p.status,
    rule: p.proposal.rule,
    covers: p.proposal.covers.length,
    confidence: p.proposal.confidence,
    sourceRun: p.sourceRun,
    generatedAt: p.proposal.generatedAt,
  };
}

export default HxMemoryGateway;
