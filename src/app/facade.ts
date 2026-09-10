// app/facade.ts — MemoryFacade: 使用层唯一 API (见 docs/architecture-v2.md §2.1)。
//
// 为什么需要它: v1 里每个宿主各自调引擎 (DSH 工具直接 `store.query`, Codex 自己读规则),
// 于是"治理闸门/去重/演化/预算"这些语义在不同宿主上各有一份实现 (或干脆没有)。
// v2 规定: **Surface 只能调用 Facade, 不能 import 引擎**。
//
// 这一层不实现检索与存储 (那是 L1/L0), 它只做用例编排:
//   remember  = 归一化 → 近邻裁决 (重复抑制/自动建边) → 落盘 (必要时并强化老条目)
//   recall    = 混合检索 + 格式化注入文本 (预算与降级由检索器给出)
//   revise/forget/link/history = 治理与审计入口 (撤回是 shadow, 永不物理删除)
//   stats     = 给面板/CLI 的可观测面
import type { MemoryEntry, Relation, RelationType } from "../kernel/types.ts";
import type { RetrievalRequest, SyncRetriever } from "../kernel/ports.ts";
import { expandEvolutionChain } from "../kernel/evolution.ts";
import { buildDraft, adjudicateNeighbors, resolveNeighbors } from "./neighbors.ts";
import { formatRetrieval } from "./format.ts";
import { aggregateStats } from "./stats.ts";
import { decideEvolution } from "../evolution/evolve.ts";
import { heuristicAdjudicator, type Adjudicator } from "../evolution/adjudicator.ts";
import { heuristicDigestBuilder, type Digest, type DigestBuilder } from "./digest.ts";
import { planStructuralLinks } from "../evolution/link.ts";
import { semanticScores } from "../retrieval/embedding.ts";
import { selectAlwaysOn } from "../trigger/policy.ts";
import { estimateTokens } from "../kernel/ranking.ts";
import type { Embedder } from "../kernel/ports.ts";

// 公开类型面在 facade-types.ts (契约与实现分开: 适配层只依赖类型文件)。
export { formatRetrieval } from "./format.ts";

export type {
  FacadeStore,
  FacadeOptions,
  RecallResponse,
  ReinforceReport,
  RememberDecision,
  RememberInput,
  RememberResult,
  MemoryStats,
} from "./facade-types.ts";
// re-export 不会把类型引入本文件作用域: 实现内部用到的那几个必须单独 import。
import type {
  FacadeOptions,
  FacadeStore,
  MemoryStats,
  RecallResponse,
  ReinforceReport,
  RememberInput,
  RememberResult,
} from "./facade-types.ts";

/**
 * 唯一对外 API。**所有**宿主 (DSH 工具 / MCP / CLI / HTTP) 都只调这里。
 */
export class MemoryFacade {
  private readonly store: FacadeStore;
  private readonly retriever: SyncRetriever;
  private readonly neighborLimit: number;
  private readonly injectionTitle: string;
  private readonly now: () => string;
  private readonly embedder?: Embedder;
  private readonly semanticDuplicateFloor: number;
  /** 实时求值: 面板里改 autoEvolve 必须当轮生效, 不能等到重启。 */
  private readonly autoEvolve: () => boolean;
  private readonly maxStructuralLinks: number;
  private readonly adjudicator: Adjudicator;
  private readonly digestBuilder: DigestBuilder;

  constructor(deps: { store: FacadeStore; retriever: SyncRetriever }, opts: FacadeOptions = {}) {
    this.store = deps.store;
    this.retriever = deps.retriever;
    this.neighborLimit = opts.neighborLimit ?? 5;
    this.injectionTitle = opts.injectionTitle ?? "相关记忆";
    this.now = opts.now ?? (() => new Date().toISOString());
    if (opts.embedder) this.embedder = opts.embedder;
    this.semanticDuplicateFloor = opts.semanticDuplicateFloor ?? 0.95;
    const autoEvolveOpt = opts.autoEvolve;
    this.autoEvolve =
      typeof autoEvolveOpt === "function" ? autoEvolveOpt : () => autoEvolveOpt !== false;
    this.maxStructuralLinks = opts.maxStructuralLinks ?? 3;
    // 默认确定性启发式: 说不清就 keep-both (交给人), 不引入不可预测性。
    this.adjudicator = opts.adjudicator ?? heuristicAdjudicator();
    this.digestBuilder = opts.digestBuilder ?? heuristicDigestBuilder();
  }

  /**
   * 记住一条内容。语义:
   *   - 近邻里已有等价表述 → 不重复落盘, 强化老条目 (reinforcement/lastHitAt) 并合并标签/实体;
   *   - 与某条老记忆相关联但不等价 → 落盘 + 自动建 relates 边 (权重 = 相似度);
   *   - 其余 → 独立落盘。
   * 返回的 decision 让调用方/面板能解释"这次到底发生了什么"。
   */
  async remember(input: RememberInput): Promise<RememberResult> {
    const content = input.content.trim();
    if (!content) throw new Error("remember: content is required");
    const at = this.now();
    const { draft, scope, kind } = buildDraft(input, content, at, () => "draft");

    const neighbors = await resolveNeighbors(
      { store: this.store, retriever: this.retriever, neighborLimit: this.neighborLimit },
      draft,
    );
    // 可选语义兜底: 一次批量嵌入 (候选 + 邻居) → 余弦表。没有 Embedder 时完全不产生开销。
    const semantic = this.embedder ? await semanticScores(this.embedder, draft, neighbors) : null;
    // 冲突裁决是异步的 (LLM 实现要调模型), 而 decideEvolution 是纯同步逻辑。
    // 因此在这里**预计算**: 只对"同类且硬冲突"的邻居跑裁决 (其余邻居不需要裁决)。
    const adjudications = await adjudicateNeighbors(
      this.adjudicator,
      this.autoEvolve(),
      draft,
      neighbors,
    );
    const decision = decideEvolution(draft, neighbors, {
      ...(adjudications.size
        ? { adjudication: (targetId: string) => adjudications.get(targetId) }
        : {}),
      ...(semantic ? { semanticSimilarity: (id: string) => semantic.get(id) } : {}),
      ...(this.embedder ? { semanticDuplicateFloor: this.semanticDuplicateFloor } : {}),
      // 关闭自动演化: 把阈值抬到不可能达到的高度 —— 只保留字面去重与建边, 不取代不标记不语义合并。
      ...(this.autoEvolve()
        ? {}
        : { supersedeFloor: 2, conflictFloor: 2, semanticDuplicateFloor: 2 }),
    });
    if (decision.action === "duplicate" && decision.targetId) {
      const target = await this.store.get(decision.targetId);
      if (target) {
        const patch: Partial<MemoryEntry> = {
          reinforcement: (target.reinforcement ?? 0) + 1,
          lastHitAt: at,
        };
        if (decision.mergedTags?.length) {
          patch.tags = [...(target.tags ?? []), ...decision.mergedTags];
        }
        if (decision.mergedEntities?.length) {
          patch.entities = [...(target.entities ?? []), ...decision.mergedEntities];
        }
        await this.store.update(target.id, patch);
        const updated = (await this.store.get(target.id)) ?? target;
        return {
          entry: updated,
          decision: "duplicate",
          targetId: target.id,
          similarity: decision.similarity,
        };
      }
    }

    // ---- 关系装配: 显式关系 + 裁决关系 + 结构关联 (标签/实体共现) ----
    const relations: Relation[] = [...(input.relations ?? [])];
    const addRelation = (relation: Relation): void => {
      if (relations.some((r) => r.type === relation.type && r.toId === relation.toId)) return;
      relations.push(relation);
    };
    if (decision.targetId) {
      if (decision.action === "link") {
        addRelation({
          type: "relates",
          toId: decision.targetId,
          weight: Number(decision.similarity.toFixed(3)),
        });
      } else if (decision.action === "supersede") {
        addRelation({ type: "supersedes", toId: decision.targetId });
      } else if (decision.action === "contradict") {
        addRelation({ type: "contradicts", toId: decision.targetId });
      }
    }
    for (const structural of planStructuralLinks(draft, neighbors, {
      maxLinks: this.maxStructuralLinks,
    })) {
      addRelation(structural);
    }
    const entry = await this.store.add({
      kind,
      content,
      source: input.source ?? "facade",
      scope,
      ...(input.project ? { project: input.project } : {}),
      ts: { validAt: input.validAt ?? at, assertedAt: at },
      ...(input.tags?.length ? { tags: input.tags } : {}),
      ...(input.entities?.length ? { entities: input.entities } : {}),
      ...(input.importance !== undefined ? { importance: input.importance } : {}),
      ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
      ...(input.derivedFrom?.length ? { derivedFrom: input.derivedFrom } : {}),
      ...(relations.length ? { relations } : {}),
    });
    // ---- 回写旧条目 (取代/冲突的反向指针) ----
    if (
      decision.targetId &&
      (decision.action === "supersede" || decision.action === "contradict")
    ) {
      const target = await this.store.get(decision.targetId);
      if (target) {
        const back: Relation[] = [...(target.relations ?? [])];
        const pushBack = (type: Relation["type"], toId: string): void => {
          if (back.some((r) => r.type === type && r.toId === toId)) return;
          back.push({ type, toId });
        };
        if (decision.action === "supersede") {
          pushBack("supersededBy", entry.id);
          // 取代是状态变更 (不删除): 旧版本从默认检索里淡出, 但历史可查、可人工改回。
          await this.store.update(target.id, { status: "superseded", relations: back });
        } else {
          // 冲突只标记: 两边都保持 active (目标若是 rule, 状态绝不由机器改)。
          pushBack("contradicts", entry.id);
          await this.store.update(target.id, { relations: back });
        }
        this.audit?.("evolve", {
          action: decision.action,
          from: entry.id,
          to: target.id,
          reason: decision.reason ?? "unspecified",
        });
      }
    }
    return {
      entry,
      decision:
        decision.action === "supersede"
          ? "superseded"
          : decision.action === "contradict"
            ? "contradicted"
            : decision.action === "link"
              ? "linked"
              : "added",
      ...(decision.targetId ? { targetId: decision.targetId } : {}),
      similarity: decision.similarity,
    };
  }

  /**
   * always-on 内容 (跨项目已确认规则 + 本项目关键事实/偏好/决策), 受 token 预算约束。
   * 这是触发层的**保底通道**: 与任何意图判定无关, 因此"模型完全没意识到要查"时也有记忆可用。
   */
  async alwaysOn(opts: { project?: string; budgetTokens?: number } = {}): Promise<MemoryEntry[]> {
    // 优先用廉价投影 (单条 SQL, 不 hydrate 关系/标签)。10k 条实测: 6ms vs 137ms。
    // 投影只含选择所需字段 (id/kind/content/scope/project/importance/status), 对 selectAlwaysOn 足够。
    const candidates = this.store.entrySummaries
      ? await this.store.entrySummaries()
      : await this.store.all();
    return selectAlwaysOn(candidates as MemoryEntry[], {
      ...(opts.project ? { project: opts.project } : {}),
      budgetTokens: opts.budgetTokens ?? 400,
      estimate: estimateTokens,
    });
  }

  /** 检索 + 格式化成注入块 (预步/会话开始/工具都走这里, 保证语义一致)。 */
  recall(req: RetrievalRequest): RecallResponse {
    const result = this.retriever.retrieveSync(req);
    return {
      hits: result.hits,
      injected: formatRetrieval(result.hits, this.injectionTitle),
      tokens: result.tokens,
      degraded: result.degraded,
    };
  }

  async get(id: string): Promise<MemoryEntry | null> {
    return await this.store.get(id);
  }

  /**
   * 最近落盘的记忆 (按写入时间倒序), 面板/CLI 的"最近沉淀"视图。
   * 走 Facade 而不是让面板直连存储: 可见性 (shadow/merged/expired 默认隐藏) 与排序口径只有一处。
   */
  async recent(limit = 20): Promise<MemoryEntry[]> {
    if (this.store.recent) return (await this.store.recent(limit)).slice(0, limit);
    const all = await this.store.all();
    return all
      .filter((e) => (e.status ?? "active") !== "shadow")
      .sort((a, b) =>
        a.ts.assertedAt < b.ts.assertedAt ? 1 : a.ts.assertedAt > b.ts.assertedAt ? -1 : 0,
      )
      .slice(0, limit);
  }

  /**
   * 生成一份"现在大概知道什么"的摘要 (Panel/CLI/注入都能用)。
   * 默认走确定性启发式 (只吃 active, 按 出现次数×importance 排序); 宿主有模型时可换 DigestBuilder 实现。
   * 摘要**不落盘** —— 它是派生视图, 每次按当前库现算, 避免"摘要陈旧"这一类失效。
   */
  async digest(opts: { project?: string } = {}): Promise<Digest> {
    const entries = this.store.entrySummaries
      ? ((await this.store.entrySummaries()) as MemoryEntry[])
      : await this.store.all();
    return this.digestBuilder.build({
      entries,
      ...(opts.project ? { project: opts.project } : {}),
    });
  }

  /** 演化链全历史 (最旧 → 最新), 用于"这条记忆怎么变成现在这样的"。 */
  async history(id: string): Promise<MemoryEntry[]> {
    const all = await this.store.all();
    return expandEvolutionChain(all, id);
  }

  /** 人工修正 (写审计字段: 改动本身留痕在真相文件的 frontmatter 里)。 */
  async revise(id: string, patch: Partial<MemoryEntry>): Promise<MemoryEntry> {
    const existing = await this.store.get(id);
    if (!existing) throw new Error("revise: not found: " + id);
    if (patch.content !== undefined && !patch.content.trim()) {
      throw new Error("revise: content cannot be emptied (用 forget 撤回)");
    }
    await this.store.update(id, patch);
    const updated = await this.store.get(id);
    if (!updated) throw new Error("revise: entry disappeared after update: " + id);
    return updated;
  }

  /**
   * 撤回 (人工显式, 持久): 写 shadow, 检索不再返回, 重建不复活。
   * why 交给 onAudit 记录 (撤回理由是可审计性的一部分, 不属于记忆内容本身)。
   */
  async forget(id: string, why: string): Promise<void> {
    const existing = await this.store.get(id);
    if (!existing) return;
    await this.store.remove(id);
    this.audit?.("forget", { id, why, at: this.now() });
  }

  /** 建边 (显式关联)。重复边由存储层主键去重。 */
  async link(a: string, b: string, type: RelationType, weight?: number): Promise<void> {
    const from = await this.store.get(a);
    if (!from) throw new Error("link: not found: " + a);
    const relation: Relation = { type, toId: b, ...(weight === undefined ? {} : { weight }) };
    const relations = [
      ...(from.relations ?? []).filter((r) => !(r.type === type && r.toId === b)),
      relation,
    ];
    await this.store.update(a, { relations });
  }

  /**
   * 命中即强化 (记忆的"用进废退"): 被检索并注入的记忆延后衰减。
   * 为什么要节流 (coalesceMs): 预步注入每个 step 都跑, 高频写盘会让真相文件产生无意义的 diff;
   * 同一个窗口内重复命中只算一次。只对 active 生效 (shadow/expired 不因命中复活)。
   */
  async reinforce(
    ids: readonly string[],
    opts: { now?: string; coalesceMs?: number } = {},
  ): Promise<ReinforceReport> {
    const at = opts.now ?? this.now();
    const coalesceMs = opts.coalesceMs ?? 60_000;
    const report: ReinforceReport = { reinforced: [], skipped: [] };
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      const entry = await this.store.get(id);
      if (!entry || (entry.status ?? "active") !== "active") {
        report.skipped.push({ id, reason: "not-active" });
        continue;
      }
      const last = entry.lastHitAt ? Date.parse(entry.lastHitAt) : Number.NaN;
      if (Number.isFinite(last) && Date.parse(at) - last < coalesceMs) {
        report.skipped.push({ id, reason: "coalesced" });
        continue;
      }
      await this.store.update(id, {
        reinforcement: (entry.reinforcement ?? 0) + 1,
        lastHitAt: at,
      });
      report.reinforced.push(id);
    }
    return report;
  }

  /** 可观测面 (面板/CLI); 分类口径在 stats.ts (纯函数, 可单独测)。 */
  async stats(): Promise<MemoryStats> {
    const aggregated = aggregateStats(await this.store.all());
    return {
      ...aggregated,
      ...(this.indexStatus ? { index: this.indexStatus() } : {}),
    };
  }

  /** 可选: 审计钩子 (撤回理由等)。缺省静默 —— 审计不该拖垮调用方。 */
  onAudit(handler: (event: string, payload: Record<string, unknown>) => void): void {
    this.audit = handler;
  }

  /** 可选: 引擎状态注入 (面板展示索引可用性/降级原因)。 */
  withIndexStatus(fn: () => unknown): void {
    this.indexStatus = fn;
  }

  private audit?: (event: string, payload: Record<string, unknown>) => void;
  private indexStatus?: () => unknown;
}
