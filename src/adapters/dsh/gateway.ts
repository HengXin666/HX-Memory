// src/adapters/dsh/gateway.ts — HX-Memory 的 DSH Web 远程服务 (Typert)。
// 暴露给前端 (dsh-client) 的只读+确认操作: review 队列浏览/确认/驳回 + 记忆检索。
// 保持薄: 所有逻辑在 GeneralizerService / FileBackend, 这里只做 RPC 投影。
import type { Context } from "@deepseek-ai/cordis";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
// 端口缺口已补 (MemoryOperations.recent): 不再需要 Pick<FileBackend> 这种"借具体类要能力"的写法。
import type { BindingConfig } from "../../kernel/binder.ts";
import type { ProposalStatus } from "../../generalize/service.ts";
import type { GeneralizationRunReport, GeneralizationStatus } from "../../kernel/types.ts";
import type { NormalizeReport } from "../../app/normalize.ts";
import {
  projectCaptureReview,
  projectEvidenceChain,
  projectPanelSearch,
  resolveCaptureReview,
  type CaptureReviewView,
} from "./gateway-memory.ts";
import { handleAlwaysOnPreview, type AlwaysOnPreview } from "./gateway-injection.ts";
// 真相文件视图 (§795): 只读列举/读取 —— 让"真相在文件"在人侧也看得见。
import { listTruthFiles, readTruthFile, type TruthFileInfo } from "./truth-files.ts";
import type { LlmInvocationRecord } from "./llm-agent.js";
import {
  projectCaptureLog,
  projectMaintenance,
  projectScheduleLog,
  type CaptureLogView,
  type MaintenanceView,
  type ScheduleLogView,
} from "./gateway-observability.js";
// 人审面 (队列提议 / 被标注记忆) 的投影: 与账本投影分开成文件, 同一理由是 gateway 的 400 行上限。
import {
  projectFlagged,
  toReviewView,
  type FlaggedMemoryView,
  type ReviewEntryView,
  type ReviewQueueView,
} from "./gateway-review.js";
// 视图形状仍从 gateway 转出: 宿主与既有测试 import 的是 gateway (契约面不搬家)。
export type { FlaggedMemoryView, ReviewEntryView, ReviewQueueView } from "./gateway-review.js";

// 依赖面声明搬到 gateway-deps.ts (本文件有 400 行上限; 它属"契约"不属"服务生命周期")。
export type { HxMemoryGatewayDeps } from "./gateway-deps.ts";
import type { HxMemoryGatewayDeps } from "./gateway-deps.ts";

declare module "@deepseek-ai/cordis" {
  interface Context {
    /** HX-Memory review gateway mounted by the DSH adapter. */
    hxMemory: HxMemoryGateway;
  }
}

export class HxMemoryGateway extends TypertRemoteService {
  // 显式字段 + 赋值 (不用 TS 参数属性): Node strip-only 模式不支持, 子进程 import 时会崩。
  private readonly deps: HxMemoryGatewayDeps;

  constructor(ctx: Context, deps: HxMemoryGatewayDeps) {
    super(ctx, "hxMemory");
    this.deps = deps;
  }

  @Remote("reviewQueue")
  reviewQueue(status: ProposalStatus): ReviewQueueView[] {
    return this.deps.generalizer.listQueue(status).map(toReviewView);
  }

  /**
   * 单条记忆 (按 id 取)。**面板人审提议时读它**: 提议只带 covers 的 id 列表,
   * 没有这个出口前端就无法把"它概括的那几条原文"显示给人看 —— 而人审的判断对象
   * 恰恰是原文, 不是 id, 也不是一个 covers 计数。
   *
   * 走 store.get (与 confirm 落规则时读 covers 的同一入口): 人审要看的是**被引用的那条**,
   * 即便它已被撤回/合并也要如实显示 (隐藏它会让"这条提议在说什么"再次变成猜测)。
   * 找不到就跳过: 单个 id 失效不该让整块展开失败。
   */
  @Remote("entriesByIds")
  entriesByIds(ids: string[]): ReviewEntryView[] {
    const out: ReviewEntryView[] = [];
    // 去重: 同一个 id 出现两次会让展开列表里出现两条一模一样的依据 (测试抓到的真实缺口)。
    const seen = new Set<string>();
    // 上限封顶: 面板一次最多展开一条提议 (covers 一簇最多几十条), 防止被构造出大扫描。
    for (const id of ids.slice(0, 100)) {
      if (typeof id !== "string" || !id || seen.has(id)) continue;
      seen.add(id);
      const e = this.deps.store.get(id);
      if (!e) continue;
      out.push({
        id: e.id,
        kind: e.kind,
        content: e.content.slice(0, 1000),
        project: e.project,
        scope: e.scope,
        status: e.status ?? "active",
        assertedAt: e.ts.assertedAt,
      });
    }
    return out;
  }

  /**
   * 被 agent 负面标注过的记忆 (按坏评数倒序)。
   * 为什么需要: 标注会**降权排序**并可能产出人审提议 —— 这两件事都必须可解释,
   * 否则"这条为什么排到后面了"无从回答 (治理动作不能是黑箱)。
   */
  @Remote("flaggedMemories")
  async flaggedMemories(limit?: number): Promise<FlaggedMemoryView[]> {
    // 走 facade.recent 而不是 store.all: 可见性 (shadow/merged/expired 默认隐藏)
    // 与排序口径只有一处 —— 面板不该看到已撤回的条目出现在"被标注"列表里。
    const rows = this.deps.facade ? await this.deps.facade.recent(500) : [];
    return projectFlagged(rows, limit);
  }

  /**
   * 跑一次推广批次 (从最近的 lesson/pattern/decision 聚类 → 提议进人工队列)。
   * 这是推广闭环的触发点之一 (另一个是 memory_rule_propose 工具);
   * 没有触发点时 review 队列永远是空的。
   */
  @Remote("runGeneralization")
  async runGeneralization(limit: number): Promise<GeneralizationRunReport & { ok: boolean }> {
    const at = new Date().toISOString();
    try {
      const report = await this.deps.generalizer.runRecent("panel:" + at, limit);
      return { ok: true, ...report };
    } catch (e) {
      // 失败也要给一份形状完整的报告: 面板只读字段, 不该因为缺字段而崩。
      return {
        ok: false,
        at,
        considered: 0,
        coveredSkipped: 0,
        clusters: 0,
        proposed: 0,
        usedLlm: false,
        tookMs: 0,
        error: String(e),
      };
    }
  }

  /** 状态视图: 面板顶部状态条读它 (AI 是否可用 / 最近一批 / 队列计数)。 */
  @Remote("generalizationStatus")
  generalizationStatus(): GeneralizationStatus {
    return this.deps.generalizer.status();
  }

  /**
   * 当前会话的项目键 (面板用它预填"当前项目"那一行; 拿不到就返回空串, 面板照常可用)。
   * 与捕获/绑定/召回**同一个派生口径** (仓库级键), 否则面板预填的项目名会与记忆里的对不上。
   */
  @Remote("currentProject")
  currentProject(): { project: string } {
    return { project: this.deps.currentProject?.() ?? "" };
  }

  /**
   * 列举真相文件 (只读, §795 文件视图)。
   *
   * 为什么这个出口重要: ADR-002 的承诺是"真相在 Markdown 文件, 索引可重建" ——
   * 而面板此前**每个视图都经 SQLite**。于是"真相在文件"在**人侧没有兑现**:
   * 用户看不到 hx-memory 到底写了什么文件、写了多少、什么时候写的。
   *
   * 边界: 只列 `{daily,digest,rules}` 下的 `.md` (不含索引与账本); 未挂载时返回空数组
   * (面板显示"未挂载", 而不是崩)。
   */
  @Remote("truthFiles")
  truthFiles(dir?: string): TruthFileInfo[] {
    const cfg = this.deps.truthFiles;
    if (!cfg) return [];
    return listTruthFiles(cfg.root, dir);
  }

  /**
   * 读一个真相文件的原文 (只读, §795)。
   *
   * ⚠ **目录穿越防护在 `readTruthFile` 里** (白名单目录 + 扩展名 + 规范化后仍在 root 内);
   * 返回 `null` 时本方法统一答"读不到" —— **不区分"不存在"与"不允许"**, 区分等于泄露路径存在性。
   */
  @Remote("truthFile")
  truthFile(path: string): { path: string; text: string } | null {
    const cfg = this.deps.truthFiles;
    if (!cfg || typeof path !== "string") return null;
    return readTruthFile(cfg.root, path);
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

  /**
   * 注入调度账本 (按会话聚合)。
   *
   * 为什么要有这个出口: 触发层的设计目标写着"'为什么没注入'必须和'注入了什么'一样可查",
   * 而 TriggerDecision 此前只活在内存里、无人读取 —— 面板是它唯一的兑现处。
   * 投影逻辑在 gateway-observability.ts (缺依赖时返回形状完整的降级对象)。
   */
  @Remote("scheduleLog")
  scheduleLog(limit?: number): ScheduleLogView {
    return projectScheduleLog(this.deps.schedule, limit);
  }

  /**
   * 后台维护状态 (最近记录 + 开关/周期)。
   *
   * 为什么这个出口是必要的: 维护是"悄悄发生的事" —— 一个只在空闲期启动子进程的任务,
   * 如果没有一个地方能看见"它跑了没有/成功没有", 用户就只能相信它。
   */
  @Remote("maintenance")
  maintenance(): MaintenanceView {
    return projectMaintenance(this.deps);
  }

  /**
   * 捕获耗时账本 (分位数 + 分阶段均值 + 最近原始记录)。
   *
   * 为什么要有这个出口: 捕获是异步的, 但异步不等于免费 —— 它调 LLM、读全库建边、同步写
   * SQLite, 全在对话所在的 event loop 上。没有它, "这一轮怎么慢了"只能靠猜 (真实问题)。
   */
  @Remote("captureLog")
  captureLog(limit?: number): CaptureLogView {
    return projectCaptureLog(this.deps.capture, limit);
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
    // recent 在端口上是**可选**的 (不是所有引擎都有"按写入时间倒序"的概念):
    // 没有就退回 query 并按 assertedAt 自行排序 —— 不假设实现具备该能力。
    const entries = this.deps.facade
      ? await this.deps.facade.recent(limit ?? 20)
      : (this.deps.store.recent?.(limit ?? 20) ??
        [...this.deps.store.query({ limit: limit ?? 20 })].sort((a, b) =>
          a.ts.assertedAt < b.ts.assertedAt ? 1 : a.ts.assertedAt > b.ts.assertedAt ? -1 : 0,
        ));
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

  /**
   * 主动整理: 把老形态的块补成当前形态 (字段补全 + 版本标记)。
   * **默认干跑**: 面板先展示"会改什么", 由人点确认才落盘 —— 真相文件是人的资产, 不是缓存。
   */
  @Remote("normalizeMemory")
  normalizeMemory(dryRun?: boolean): NormalizeReport | { error: string } {
    if (!this.deps.normalizer) return { error: "normalizer not mounted" };
    const run = dryRun !== false;
    try {
      return this.deps.normalizer.run({ dryRun: run });
    } catch (e) {
      return { error: String(e) };
    }
  }

  /**
   * 待裁决的矛盾集合 (双向 contradicts 边)。
   *
   * 为什么需要它: 写入期裁决为 keep-both 时只落了一条边并注释"需人工处理",
   * 但此前**没有任何入口能列出这些矛盾** —— 数据在库里, 却没人看得见, 等于永久悬空。
   */
  @Remote("contradictions")
  contradictions(
    limit?: number,
  ): Array<{ id: string; kind: string; content: string; withId: string }> {
    const max = Math.min(200, Math.max(1, limit ?? 50));
    const all = this.deps.store.query({ limit: Number.MAX_SAFE_INTEGER });
    const out: Array<{ id: string; kind: string; content: string; withId: string }> = [];
    for (const e of all) {
      for (const r of e.relations ?? []) {
        if (r.type !== "contradicts") continue;
        out.push({ id: e.id, kind: e.kind, content: e.content, withId: r.toId });
        if (out.length >= max) return out;
      }
    }
    return out;
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

  // 待审裁决 (接受 / 丢弃)。形参名是协议面 (见 evidenceChain 的说明): id 与 action。
  @Remote("resolveCaptureReview")
  async resolveCaptureReview(id: string, action: string): Promise<{ ok: boolean; error?: string }> {
    return await resolveCaptureReview(this.deps.facade, this.deps.captureReview, id, action);
  }

  // 注入预览: "会注入什么" + "什么因配额没进来" (形参名是协议面; 实现在 gateway-injection.ts)。
  @Remote("alwaysOnPreview")
  async alwaysOnPreview(project: string): Promise<AlwaysOnPreview> {
    // 预算与 openMemoryStack 的 always-on 默认值同源 (400)。
    return await handleAlwaysOnPreview(this.deps, project, 400);
  }

  // 捕获待审队列: 可疑候选的出口 (投影在 gateway-memory.ts; 形参名是协议面)。
  @Remote("captureReviewQueue")
  captureReviewQueue(limit: number): CaptureReviewView {
    return projectCaptureReview(this.deps.captureReview, limit);
  }

  // 证据链: 面板侧"追来源"入口 (投影在 gateway-memory.ts, 与 memory_evidence 工具共用同一 Facade 方法)。
  // 形参名是**协议面**: Typert 按名映射 args, 写成 (q: {id}) 会被宿主拒 —— 单测绕过该校验。
  @Remote("evidenceChain")
  async evidenceChain(id: string): Promise<unknown> {
    return await projectEvidenceChain(this.deps.facade, id);
  }

  // 检索出口 (投影在 gateway-memory.ts: 与工具/面板共用同一语义)。
  @Remote("memoryQuery")
  async memoryQuery(q: { text?: string; kind?: string; limit?: number }): Promise<unknown[]> {
    return await projectPanelSearch(this.deps.facade, this.deps.store, q);
  }
}

export default HxMemoryGateway;
