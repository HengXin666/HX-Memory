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
import type {
  MemoryEntry,
  MemoryEntryInput,
  MemoryKind,
  MemoryScope,
  MemoryStatus,
  Query,
  Relation,
  RelationType,
} from "../kernel/types.ts";
import type { Awaitable, RetrievalHit, RetrievalRequest, SyncRetriever } from "../kernel/ports.ts";
import { expandEvolutionChain } from "../kernel/evolution.ts";
import { normalizeFingerprint } from "../evolution/associate.ts";
import { decideEvolution } from "../evolution/evolve.ts";
import { planStructuralLinks } from "../evolution/link.ts";
import { semanticScores } from "../retrieval/embedding.ts";
import type { Embedder } from "../kernel/ports.ts";

/** Facade 对存储的最小要求 (FileBackend/SQLite/远端实现都能满足)。 */
export interface FacadeStore {
  add(entry: MemoryEntryInput): Awaitable<MemoryEntry>;
  get(id: string): Awaitable<MemoryEntry | null>;
  update(id: string, patch: Partial<MemoryEntry>): Awaitable<void>;
  remove(id: string): Awaitable<void>;
  all(): Awaitable<MemoryEntry[]>;
  query(q: Query): Awaitable<MemoryEntry[]>;
  traverse(fromId: string, relationType: string): Awaitable<MemoryEntry[]>;
  /** 全文检索面 (近邻裁决与"相关内容"用)。 */
  searchText(text: string, limit?: number): MemoryEntry[];
  /** 可选: "最近沉淀"视图 (面板用); 缺省时 Facade 用 all() 自行排序。 */
  recent?(limit?: number): Awaitable<MemoryEntry[]>;
}

export interface RememberInput {
  content: string;
  kind?: MemoryKind;
  project?: string;
  scope?: MemoryScope;
  /** 溯源: 会话 id / 文件 / URL; 缺省 "facade"。 */
  source?: string;
  tags?: string[];
  entities?: string[];
  importance?: number;
  confidence?: number;
  /** 血缘: 本条由哪些 episode 抽取而来 (支撑抽取级重建)。 */
  derivedFrom?: string[];
  validAt?: string;
  relations?: Relation[];
}

export type RememberDecision =
  | "added"
  /** 近等价重述: 不重复落盘, 强化老条目并合并标签/实体。 */
  | "duplicate"
  /** 与老记忆相关: 落盘 + 自动建 relates 边。 */
  | "linked"
  /** 显式更新 (改为/不再/废弃...): 新条目 supersedes 旧的, 旧的置 superseded (不删除)。 */
  | "superseded"
  /** 数字/极性矛盾且无更新信号: 两边都保留 + 双向 contradicts 边 (等人/LLM 裁决)。 */
  | "contradicted";

export interface RememberResult {
  entry: MemoryEntry;
  decision: RememberDecision;
  /** duplicate/link 的目标条目。 */
  targetId?: string;
  similarity?: number;
}

export interface RecallResponse {
  hits: RetrievalHit[];
  /** 已格式化的注入块 (空串 = 不注入)。 */
  injected: string;
  tokens: number;
  degraded: string[];
}

export interface ReinforceReport {
  reinforced: string[];
  skipped: Array<{ id: string; reason: "not-active" | "coalesced" }>;
}

export interface MemoryStats {
  total: number;
  byKind: Record<string, number>;
  byStatus: Record<string, number>;
  projects: string[];
  rules: number;
  /** 引擎自述 (索引可用性/降级原因), 有则带上。 */
  index?: unknown;
}

export interface FacadeOptions {
  /** 裁决用的近邻数 (0 = 关闭去重与自动建边)。 */
  neighborLimit?: number;
  /** 注入块的标题。 */
  injectionTitle?: string;
  now?: () => string;
  /** 可选嵌入器: 有则启用语义兜底去重 (换说法也能认出重复)。 */
  embedder?: Embedder;
  /** 语义判重的阈值 (默认 0.95; 越高越保守)。 */
  semanticDuplicateFloor?: number;
  /** 关闭自动演化 (取代/冲突标记): 只做去重与建边。 */
  autoEvolve?: boolean;
  /** 单次写入最多建几条结构关联边 (默认 3; 0 = 关闭)。 */
  maxStructuralLinks?: number;
}

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
  private readonly autoEvolve: boolean;
  private readonly maxStructuralLinks: number;

  constructor(deps: { store: FacadeStore; retriever: SyncRetriever }, opts: FacadeOptions = {}) {
    this.store = deps.store;
    this.retriever = deps.retriever;
    this.neighborLimit = opts.neighborLimit ?? 5;
    this.injectionTitle = opts.injectionTitle ?? "相关记忆";
    this.now = opts.now ?? (() => new Date().toISOString());
    if (opts.embedder) this.embedder = opts.embedder;
    this.semanticDuplicateFloor = opts.semanticDuplicateFloor ?? 0.95;
    this.autoEvolve = opts.autoEvolve !== false;
    this.maxStructuralLinks = opts.maxStructuralLinks ?? 3;
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
    const scope: MemoryScope = input.scope ?? (input.project ? "project" : "agent");
    const kind: MemoryKind = input.kind ?? "fact";
    const draft: MemoryEntry = {
      id: "draft",
      kind,
      content,
      source: input.source ?? "facade",
      scope,
      ts: { validAt: input.validAt ?? at, assertedAt: at },
      ...(input.project ? { project: input.project } : {}),
      ...(input.tags?.length ? { tags: input.tags } : {}),
      ...(input.entities?.length ? { entities: input.entities } : {}),
      ...(input.importance !== undefined ? { importance: input.importance } : {}),
      ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
    };

    const neighbors = await this.neighborsFor(draft);
    // 可选语义兜底: 一次批量嵌入 (候选 + 邻居) → 余弦表。没有 Embedder 时完全不产生开销。
    const semantic = this.embedder ? await semanticScores(this.embedder, draft, neighbors) : null;
    const decision = decideEvolution(draft, neighbors, {
      ...(semantic ? { semanticSimilarity: (id: string) => semantic.get(id) } : {}),
      ...(this.embedder ? { semanticDuplicateFloor: this.semanticDuplicateFloor } : {}),
      // 关闭自动演化: 把阈值抬到不可能达到的高度 —— 只保留字面去重与建边, 不取代不标记不语义合并。
      ...(this.autoEvolve ? {} : { supersedeFloor: 2, conflictFloor: 2, semanticDuplicateFloor: 2 }),
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
    if (decision.targetId && (decision.action === "supersede" || decision.action === "contradict")) {
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
      .sort((a, b) => (a.ts.assertedAt < b.ts.assertedAt ? 1 : a.ts.assertedAt > b.ts.assertedAt ? -1 : 0))
      .slice(0, limit);
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
    const relations = [...(from.relations ?? []).filter((r) => !(r.type === type && r.toId === b)), relation];
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

  /** 可观测面 (面板/CLI)。 */
  async stats(): Promise<MemoryStats> {
    const all = await this.store.all();
    const byKind: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    const projects = new Set<string>();
    let rules = 0;
    for (const e of all) {
      byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
      const status: MemoryStatus = e.status ?? "active";
      byStatus[status] = (byStatus[status] ?? 0) + 1;
      if (e.project) projects.add(e.project);
      if (e.kind === "rule" && e.confirmedBy && e.confirmedAt) rules++;
    }
    return {
      total: all.length,
      byKind,
      byStatus,
      projects: [...projects].sort(),
      rules,
      ...(this.indexStatus ? { index: this.indexStatus() } : {}),
    };
  }

  /**
   * 内部: 近邻候选 (裁决输入)。三路合并, 因为三种裁决需要不同的候选面:
   *   1. 文本检索 → 近义重述 / 冲突 (同种类);
   *   2. 标签共现 → 结构关联 (共享标签但不一定字面相似);
   *   3. 全局规则 → 与规则冲突必须能被发现 (规则本身绝不被机器改)。
   * 内容太短时不查 (避免和一堆短条目误判重复)。
   */
  private async neighborsFor(draft: MemoryEntry): Promise<MemoryEntry[]> {
    if (this.neighborLimit <= 0) return [];
    if (normalizeFingerprint(draft.content).length < 4) return [];
    const found = new Map<string, MemoryEntry>();
    const collect = (entries: readonly MemoryEntry[]): void => {
      for (const entry of entries) {
        if (entry.id === draft.id) continue;
        if (!found.has(entry.id)) found.set(entry.id, entry);
      }
    };
    // 裁决用的检索: 关掉图扩展、向量通道与去冗余 —— 近邻裁决只要"字面最像的几条",
    // 语义相似度由下面的 embedding 余弦单独提供 (semanticScores), 不需要走向量召回通道。
    // 这样每次写入就不会触发"向量索引全量对账"(实测这是写入路径的主要开销)。
    collect(
      this.retriever
        .retrieveSync({
          text: draft.content,
          limit: this.neighborLimit,
          kinds: [draft.kind],
          expand: { graph: 0 },
          channels: { vector: { enabled: false }, graph: { enabled: false } },
          ...(draft.project ? { scope: { project: draft.project } } : {}),
        })
        .hits.map((h) => h.entry),
    );
    for (const tag of draft.tags ?? []) {
      collect(await this.store.query({ tag, limit: this.neighborLimit }));
    }
    collect(await this.store.query({ kind: "rule", scope: "global", limit: 5 }));
    // 上限: 裁决是 O(邻居) 的, 不能让候选面无限膨胀。
    return [...found.values()].slice(0, Math.max(12, this.neighborLimit * 3));
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

/** 注入块格式化 (与 v1 的注入风格一致, 便于人读与 diff)。 */
export function formatRetrieval(hits: readonly RetrievalHit[], title: string): string {
  if (!hits.length) return "";
  const lines = ["【" + title + "】"];
  for (const hit of hits) {
    const e = hit.entry;
    const prefix = e.kind === "rule" ? "[规则] " : "";
    lines.push("- " + prefix + "[" + e.id + "] " + e.content);
  }
  return lines.join("\n");
}
