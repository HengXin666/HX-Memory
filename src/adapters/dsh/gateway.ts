// src/adapters/dsh/gateway.ts — HX-Memory 的 DSH Web 远程服务 (Typert)。
// 暴露给前端 (dsh-client) 的只读+确认操作: review 队列浏览/确认/驳回 + 记忆检索。
// 保持薄: 所有逻辑在 GeneralizerService / FileBackend, 这里只做 RPC 投影。
import type { Context } from "@deepseek-ai/cordis";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import type { FileBackend } from "../../storage/file-store.ts";
import type { BindingStore } from "../../bindings/store.ts";
import type { BindingConfig } from "../../kernel/binder.ts";
import type {
  GeneralizerService,
  ProposalStatus,
  QueuedProposal,
} from "../../generalize/service.ts";
import type { InvocationLog } from "./invocations.js";
import type { LlmInvocationRecord } from "./llm-agent.js";

/** Gateway 依赖的最小端口 (可插拔: 便于测试注入, 也便于换实现)。 */
export interface HxMemoryGatewayDeps {
  store: Pick<FileBackend, "query" | "get" | "remove" | "recent">;
  generalizer: Pick<GeneralizerService, "listQueue" | "confirm" | "reject" | "runBatch">;
  /** 绑定配置存储 (可选: 不注入则面板的绑定页不可用)。 */
  bindingStore?: BindingStore;
  /** AI 调用记录 (可选: 不注入则「调用记录」tab 不可用)。 */
  invocations?: InvocationLog;
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

  @Remote("listBindings")
  listBindings(): BindingConfig[] {
    return this.deps.bindingStore?.list() ?? [];
  }

  @Remote("saveBindings")
  saveBindings(configs: unknown): { ok: boolean; error?: string } {
    if (!this.deps.bindingStore) return { ok: false, error: "binding store not mounted" };
    try {
      this.deps.bindingStore.saveAll(configs as BindingConfig[]);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  @Remote("listInvocations")
  listInvocations(limit?: number): LlmInvocationRecord[] {
    return this.deps.invocations?.recent(limit ?? 50) ?? [];
  }

  @Remote("recentCaptures")
  recentCaptures(limit?: number): Array<{
    id: string;
    kind: string;
    content: string;
    project?: string;
    scope: string;
    assertedAt: string;
    tags?: string[];
  }> {
    return this.deps.store.recent(limit ?? 20).map((e) => ({
      id: e.id,
      kind: e.kind,
      content: e.content,
      project: e.project,
      scope: e.scope,
      assertedAt: e.ts.assertedAt,
      tags: e.tags,
    }));
  }

  @Remote("deleteEntry")
  deleteEntry(id: string): { ok: boolean; error?: string } {
    try {
      this.deps.store.remove(id);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
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
