// src/adapters/dsh/gateway.ts — HX-Memory 的 DSH Web 远程服务 (Typert)。
// 暴露给前端 (dsh-client) 的只读+确认操作: review 队列浏览/确认/驳回 + 记忆检索。
// 保持薄: 所有逻辑在 GeneralizerService / FileBackend, 这里只做 RPC 投影。
import type { Context } from "@deepseek-ai/cordis";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import type { FileBackend } from "../../storage/file-store.ts";
import type { MemoryStore } from "../../kernel/ports.ts";
import type { MemoryFacade } from "../../app/facade.ts";
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
  /** 面板只需要端口能力 + recent (面板专属的"最近沉淀"视图)。 */
  store: Pick<MemoryStore, "query" | "get" | "remove"> & Pick<FileBackend, "recent">;
  generalizer: Pick<
    GeneralizerService,
    "listQueue" | "confirm" | "reject" | "runBatch" | "runRecent" | "enqueueProposal"
  >;
  /** 绑定配置存储 (可选: 不注入则面板的绑定页不可用)。 */
  bindingStore?: BindingStore;
  /** AI 调用记录 (可选: 不注入则「调用记录」tab 不可用)。 */
  invocations?: InvocationLog;
  /**
   * 使用层 Facade (可选但推荐): 面板的"最近沉淀/搜索/删除"与工具、MCP、CLI 共用同一套语义
   * (检索排序 + 治理闸门 + 可见性 + 审计)。不注入时退回直连存储的旧行为 (兼容测试/旧宿主)。
   */
  facade?: Pick<MemoryFacade, "recent" | "forget" | "recall">;
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
  reviewQueue(status: ProposalStatus): ReviewQueueView[] {
    return this.deps.generalizer.listQueue(status).map(toView);
  }

  /**
   * 跑一次推广批次 (从最近的 lesson/pattern/decision 聚类 → 提议进人工队列)。
   * 这是推广闭环的触发点之一 (另一个是 memory_rule_propose 工具);
   * 没有触发点时 review 队列永远是空的。
   */
  @Remote("runGeneralization")
  async runGeneralization(
    limit: number,
  ): Promise<{ ok: boolean; proposed: number; error?: string }> {
    try {
      const created = await this.deps.generalizer.runRecent(
        "panel:" + new Date().toISOString(),
        limit,
      );
      return { ok: true, proposed: created.length };
    } catch (e) {
      return { ok: false, proposed: 0, error: String(e) };
    }
  }

  @Remote("confirmProposal")
  confirmProposal(
    id: string,
    by: string,
  ): Promise<{ ok: boolean; ruleId?: string; error?: string }> {
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
  async recentCaptures(limit?: number): Promise<
    Array<{
      id: string;
      kind: string;
      content: string;
      project?: string;
      scope: string;
      assertedAt: string;
      tags?: string[];
    }>
  > {
    const entries = this.deps.facade
      ? await this.deps.facade.recent(limit ?? 20)
      : this.deps.store.recent(limit ?? 20);
    return entries.map((e) => ({
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
  async deleteEntry(id: string): Promise<{ ok: boolean; error?: string }> {
    try {
      if (this.deps.facade) {
        // 走 Facade: 撤回是 shadow + 留审计理由 (面板删除不再是"无名操作")。
        await this.deps.facade.forget(id, "panel:deleteEntry");
      } else {
        this.deps.store.remove(id);
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  @Remote("memoryQuery")
  async memoryQuery(q: { text?: string; kind?: string; limit?: number }): Promise<unknown[]> {
    const limit = q.limit ?? 10;
    // 有 Facade → 与工具/MCP/CLI 同一条检索语义 (含规则保底、覆盖率过滤、token 预算、降级说明)。
    const entries = this.deps.facade
      ? this.deps.facade
          .recall({
            ...(q.text ? { text: q.text } : {}),
            ...(q.kind ? { kinds: [q.kind as never] } : {}),
            limit,
            tokenBudget: Math.max(400, limit * 160),
          })
          .hits.map((hit) => hit.entry)
      : await this.deps.store.query({ text: q.text, kind: q.kind as never, limit });
    return entries.map((e) => ({
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
