// retrieval/hybrid.ts — 默认检索实现: 多通道召回 → RRF 融合 → 覆盖率过滤 → 时间衰减 → MMR → 预算裁剪。
//
// 为什么在应用层而不是存储层: 排序策略 (通道权重/衰减/去冗余) 是最常调、也最该集中调的部分;
// 它只依赖 RetrievalSource 这个窄端口, 因此换存储/换检索引擎时这层代码不用动。
//
// 设计取舍 (诚实边界):
//   - 没有向量时, "语义相似"退化为"词/bigram 覆盖率"; 覆盖率过滤是为了压掉 bigram 宽召回带来的噪声;
//   - 规则 (已确认跨项目规则) 走独立通道 + 保底配额: 它们不允许被其它通道挤掉 (v1 是"全量候选", 那样会淹没注入预算);
//   - 命中 superseded/merged 版本时, 自动沿演化链上溯到最新 active 版本 (注入最新, 历史可查);
//   - 全部为纯逻辑 + 窄端口, S1 可用假 source 测。
import type { Query, MemoryEntry, RelationType } from "../kernel/types.ts";
import { expandEvolutionChain } from "../kernel/evolution.ts";
import { searchableText, termStreams } from "../kernel/cjk.ts";
import {
  applyTokenBudget,
  compositeScore,
  estimateTokens,
  jaccardOfSets,
  mmrSelect,
  rrfFuse,
  type RankedList,
} from "../kernel/ranking.ts";
import type {
  Channel,
  IndexableSource,
  RetrievalCapabilities,
  RetrievalHit,
  RetrievalRequest,
  RetrievalResult,
  RetrievalSource,
  RetrievalWarmup,
  Retriever,
  SyncRetriever,
  VectorIndex,
} from "../kernel/ports.ts";

export interface HybridRetrieverOptions {
  /** 每个通道的候选数 (再融合)。 */
  channelLimit?: number;
  /** 覆盖率下限 (0..1): 低于它且命中词数不足的候选被丢弃 (压 bigram 噪声)。 */
  coverageFloor?: number;
  /** 图扩展的默认跳数。 */
  graphHops?: 0 | 1 | 2;
  rrfK?: number;
  mmrLambda?: number;
  /** 时钟 (测试可注入)。 */
  now?: () => string;
  capabilities?: RetrievalCapabilities;
  /** 向量索引 (有则启用语义召回通道; 实现可换 sqlite-vec/LanceDB/Qdrant)。 */
  vectorIndex?: VectorIndex;
}

const DEFAULT_CAPS: RetrievalCapabilities = {
  engine: "unknown",
  fullText: true,
  cjk: true,
  semantic: false,
  graph: "relations",
  multiProcess: false,
};

/** 关系类型的默认图扩展权重 (越"强关联"的边权重越高)。 */
const GRAPH_EDGE_WEIGHT: Partial<Record<RelationType, number>> = {
  supersedes: 1.0,
  supersededBy: 1.0,
  generalizes: 0.9,
  instanceOf: 0.9,
  mentions: 0.6,
  relates: 0.5,
  sameAs: 0.8,
  source: 0.3,
  derivedFrom: 0.2,
  contradicts: 0.4,
  appliesTo: 0.7,
};

interface QueryTerms {
  /** 去重后的查询词 (词流 + bigram 流)。 */
  terms: string[];
  /** 用于覆盖率计算的重词 (优先词流; 无词流时用 bigram)。 */
  weighted: string[];
}

function queryTerms(text: string): QueryTerms {
  const streams = termStreams(text);
  const all: string[] = [];
  const seen = new Set<string>();
  for (const t of [...streams.words, ...streams.bigrams]) {
    if (seen.has(t)) continue;
    seen.add(t);
    all.push(t);
  }
  // 词流是"真正的词", 覆盖率以它为主; 没有词流 (纯 CJK 被切碎) 时退回 bigram。
  const weighted = streams.words.length ? streams.words : all;
  return { terms: all.slice(0, 64), weighted: weighted.slice(0, 32) };
}

function coverage(text: string, terms: readonly string[]): number {
  if (!terms.length) return 0;
  const haystack = text.toLowerCase();
  let hit = 0;
  for (const t of terms) if (haystack.includes(t)) hit++;
  return hit / terms.length;
}

/**
 * 默认检索器。同步实现 (SQLite 类引擎足够快), 因此同时满足 Retriever 与 SyncRetriever ——
 * 预步注入不需要额外的投影层; 将来接异步引擎时, 这一层之上再加投影即可。
 */
export class HybridRetriever implements Retriever, SyncRetriever, RetrievalWarmup {
  private readonly channelLimit: number;
  private readonly coverageFloor: number;
  private readonly graphHops: 0 | 1 | 2;
  private readonly rrfK: number;
  private readonly mmrLambda: number;
  private readonly now: () => string;
  private readonly caps: RetrievalCapabilities;
  private readonly vectorIndex?: VectorIndex;
  /** 向量索引已同步到的写版本号 (变了才重新投影, 稳态查询零开销)。 */
  private vectorSyncedRevision = -1;

  private readonly source: RetrievalSource;

  constructor(source: RetrievalSource, opts: HybridRetrieverOptions = {}) {
    // 参数属性 (constructor(private x)) 在 Node strip-only TS 模式下不被支持, 这里显式赋值。
    this.source = source;
    this.channelLimit = opts.channelLimit ?? 30;
    this.coverageFloor = opts.coverageFloor ?? 0.5;
    this.graphHops = opts.graphHops ?? 1;
    this.rrfK = opts.rrfK ?? 60;
    this.mmrLambda = opts.mmrLambda ?? 0.7;
    this.now = opts.now ?? (() => new Date().toISOString());
    this.vectorIndex = opts.vectorIndex;
    // 能力来源优先级: 显式配置 > 引擎自述 > 保守默认 (宁可少宣称能力, 也不要谎报)。
    // 有向量索引时才宣称 semantic —— 能力自述必须与真实行为一致 (conformance 会断言)。
    const declared = opts.capabilities ?? source.capabilities?.() ?? DEFAULT_CAPS;
    this.caps =
      opts.vectorIndex && !opts.capabilities
        ? { ...declared, semantic: true, engine: declared.engine + "+vec" }
        : declared;
  }

  capabilities(): RetrievalCapabilities {
    return this.caps;
  }

  /**
   * 预热向量投影 (异步嵌入器专用), 带硬时限。
   * 语义: "尽力而为" —— 超时不报错、不抛出, 未补完的部分下轮继续;
   * 预步注入因此在最坏情况下也只多花 deadlineMs, 而换来后续轮次的真语义召回。
   */
  async warm(deadlineMs = 50, query?: string): Promise<void> {
    const refresh = this.vectorIndex?.refresh;
    if (!refresh) return;
    // 先触发一次同步投影登记 (否则 refresh 无活可干)。
    this.syncVectorIndex();
    // 把本轮查询也排进队列: 否则第一轮永远只有"文档就绪、查询未就绪" (命中为空)。
    if (query) this.vectorIndex?.prime?.(query);
    const bounded = Math.max(0, Math.min(deadlineMs, 2000));
    if (bounded === 0) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.resolve(refresh.call(this.vectorIndex)).catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, bounded);
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  /**
   * 同步预热 (仅对同步嵌入器有效): 把向量投影现在就算好, 让**首次查询**就是热的。
   * 10k 条实测: 首次查询要现建索引约 160ms, 之后再查 12ms —— 启动时补一次就没有这个毛刺。
   * 异步嵌入器 (ProjectedVectorIndex) 没有同步补齐的语义, 这里直接跳过 (由 warm() 负责)。
   */
  warmSync(): void {
    this.syncVectorIndex();
  }

  ready(): boolean {
    return this.vectorIndex?.ready !== false;
  }

  async retrieve(req: RetrievalRequest): Promise<RetrievalResult> {
    return this.retrieveSync(req);
  }

  retrieveSync(req: RetrievalRequest): RetrievalResult {
    const limit = Math.max(1, req.limit ?? 8);
    const tokenBudget = req.tokenBudget ?? 1200;
    // 候选窗口随请求条数伸缩: 要 5 条却去 hydrate 60 条候选是纯浪费
    // (每条 hydrate 还要 2 次 relations/tags 查询) —— 实测这是小 limit 检索的主要开销。
    const candidateWindow = Math.max(12, Math.min(this.channelLimit * 2, limit * 4));
    const at = req.asOf;
    const includeHidden = req.includeHidden ?? false;
    const degraded: string[] = [];
    if (!this.caps.semantic) degraded.push("semantic:no-embedder (回退 词/bigram 覆盖率)");
    if (!this.caps.fullText) degraded.push("fullText:like-fallback (无 BM25 排序)");

    const text = req.text ?? "";
    const terms = queryTerms(text);
    const enabled = (c: Channel): boolean => req.channels?.[c]?.enabled !== false;
    const weightOf = (c: Channel): number => req.channels?.[c]?.weight ?? 1;

    const byId = new Map<string, MemoryEntry>();
    const remember = (e: MemoryEntry): MemoryEntry => {
      const prev = byId.get(e.id);
      if (prev) return prev;
      byId.set(e.id, e);
      return e;
    };

    // 单次检索内缓存"可检索文本"与"词集": 覆盖率过滤与 MMR 去冗余都会反复用到它们,
    // 现算会让延迟变成 O(候选 × 分词) 甚至 O(候选²) —— 实测这是万级检索的主要热点。
    const textCache = new Map<string, string>();
    const tokenCache = new Map<string, Set<string>>();
    const textOf = (e: MemoryEntry): string => {
      const cached = textCache.get(e.id);
      if (cached !== undefined) return cached;
      const text = searchableText(e);
      textCache.set(e.id, text);
      return text;
    };
    const tokensOf = (e: MemoryEntry): Set<string> => {
      const cached = tokenCache.get(e.id);
      if (cached !== undefined) return cached;
      const set = new Set<string>();
      const streams = termStreams(textOf(e));
      for (const t of streams.words) set.add(t);
      for (const t of streams.bigrams) set.add(t);
      tokenCache.set(e.id, set);
      return set;
    };

    const visible = (e: MemoryEntry): boolean => {
      if (includeHidden) return true;
      const status = e.status ?? "active";
      return status === "active" || status === "superseded";
    };
    const inScope = (e: MemoryEntry): boolean => {
      if (at && e.ts.validAt > at) return false;
      if (req.kinds?.length && !req.kinds.includes(e.kind)) return false;
      if (
        req.scope?.project !== undefined &&
        e.project !== undefined &&
        e.project !== req.scope.project &&
        e.scope === "project"
      )
        return false;
      if (req.scope?.global === false && e.scope === "global") return false;
      return true;
    };
    /**
     * 治理铁律 (与存储层同一口径, 但必须在这里再校验一次):
     * 存储闸门挡的是"写入", 这里挡的是"任何来源的 rule 条目" ——
     * 手工编辑的真相文件、旧版本遗留数据、别处同步进来的条目都可能带一条没有确认记录的 rule。
     */
    const confirmedRule = (e: MemoryEntry): boolean =>
      e.kind !== "rule" || Boolean(e.confirmedBy && e.confirmedAt);
    const keep = (e: MemoryEntry): boolean => visible(e) && inScope(e) && confirmedRule(e);
    /** 候选资格: 词数门槛 + 覆盖率门槛 (规则通道豁免)。 */
    const qualifies = (e: MemoryEntry): boolean => {
      if (!terms.terms.length) return true;
      const text = textOf(e);
      const cov = coverage(text, terms.weighted.length ? terms.weighted : terms.terms);
      const matched = terms.weighted.filter((t) => text.toLowerCase().includes(t)).length;
      if (cov >= this.coverageFloor) return true;
      return matched >= 2 && cov >= 0.15;
    };

    const ranked: RankedList[] = [];
    const reasons = new Map<string, string[]>();

    const addReason = (id: string, reason: string): void => {
      const list2 = reasons.get(id) ?? [];
      list2.push(reason);
      reasons.set(id, list2);
    };

    // ---- 通道 1: 已确认的跨项目规则 (保底通道; 不受覆盖率过滤影响) ----
    if (enabled("rules")) {
      const rules = this.source
        .query({ kind: "rule" })
        .filter((r) => r.scope === "global")
        .filter(keep);
      const scored = rules
        .map((r) => {
          const rel = terms.weighted.length ? coverage(textOf(r), terms.weighted) : 0.5;
          return { r, rel };
        })
        .sort((a, b) => b.rel - a.rel)
        .slice(0, this.channelLimit);
      for (const { r } of scored) {
        remember(r);
        addReason(r.id, "rules:confirmed-global");
      }
      ranked.push({
        channel: "rules",
        ids: scored.map((s) => s.r.id),
        weight: weightOf("rules") * 1.5,
      });
    }

    // ---- 通道 2: 全文检索 (BM25) ----
    if (enabled("bm25") && text.trim()) {
      const hits = this.source.searchText(text, candidateWindow).filter(keep);
      const qualified: MemoryEntry[] = [];
      const dropped: string[] = [];
      for (const e of hits) {
        remember(e);
        if (qualifies(e)) {
          qualified.push(e);
          addReason(e.id, "bm25:" + this.caps.engine);
        } else {
          dropped.push(e.id);
        }
      }
      for (const id of dropped) addReason(id, "filtered:low-coverage");
      ranked.push({
        channel: "bm25",
        ids: qualified.slice(0, this.channelLimit).map((e) => e.id),
        weight: weightOf("bm25"),
      });
    }

    // ---- 通道 2b: 向量 (语义召回) ----
    if (enabled("vector") && text.trim() && this.vectorIndex) {
      this.syncVectorIndex();
      // 异步嵌入器的投影: 触发后台补齐 (不 await —— 预步注入绝不等 IO);
      // 未就绪时明确记降级, 而不是静默地"这次没有语义召回"。
      if (typeof this.vectorIndex.refresh === "function") {
        void this.vectorIndex.refresh().catch(() => undefined);
        if (this.vectorIndex.ready === false) {
          degraded.push("vector:projection-warming (异步嵌入器尚未补齐, 本轮仅字面召回)");
        }
      }
      const vectorIds: string[] = [];
      for (const hit of this.vectorIndex.search(text, candidateWindow)) {
        const entry = byId.get(hit.id) ?? this.source.get(hit.id) ?? undefined;
        if (!entry || !keep(entry)) continue;
        remember(entry);
        // 向量通道**不做**字面覆盖率过滤 —— "字面不重合但语义相近"正是它存在的意义。
        if (!vectorIds.includes(entry.id)) {
          vectorIds.push(entry.id);
          addReason(entry.id, "vector:" + hit.score.toFixed(3));
        }
      }
      if (vectorIds.length) {
        ranked.push({ channel: "vector", ids: vectorIds, weight: weightOf("vector") });
      }
    }

    // ---- 通道 3: 标签 ----
    if (enabled("tag") && req.tags?.length) {
      const tagged: MemoryEntry[] = [];
      for (const tag of req.tags) {
        for (const e of this.source.query({ tag, limit: candidateWindow })) {
          if (!keep(e)) continue;
          remember(e);
          if (!tagged.some((x) => x.id === e.id)) tagged.push(e);
          addReason(e.id, "tag:" + tag);
        }
      }
      ranked.push({ channel: "tag", ids: tagged.map((e) => e.id), weight: weightOf("tag") });
    }

    // ---- 通道 4: 图扩展 (种子 = 目前得分最高的若干条) ----
    const hops = req.expand?.graph ?? this.graphHops;
    if (enabled("graph") && hops > 0 && ranked.length) {
      const seeds = ranked
        .flatMap((l) => l.ids.slice(0, 5))
        .filter((id, i, arr) => arr.indexOf(id) === i)
        .slice(0, 5);
      const graphIds: string[] = [];
      const perSeedCap = 3;
      const edges = (Object.keys(GRAPH_EDGE_WEIGHT) as RelationType[]).sort(
        (a, b) => (GRAPH_EDGE_WEIGHT[b] ?? 0) - (GRAPH_EDGE_WEIGHT[a] ?? 0),
      );
      for (const seedId of seeds) {
        let perSeed = 0;
        for (const type of edges) {
          for (const neighbor of this.source.traverse(seedId, type)) {
            if (!keep(neighbor) || perSeed >= perSeedCap) continue;
            remember(neighbor);
            if (!graphIds.includes(neighbor.id)) {
              graphIds.push(neighbor.id);
              perSeed++;
            }
            // 图扩展**不做**文本覆盖率过滤: "结构相关但字面不相关"正是图通道存在的意义。
            // 噪声由 perSeedCap + RRF 的低排名 + 预算裁剪共同控制。
            addReason(neighbor.id, "graph:" + type + ":" + seedId);
          }
        }
      }
      if (graphIds.length) {
        ranked.push({ channel: "graph", ids: graphIds, weight: weightOf("graph") });
      }
    }

    // ---- 融合 + 演化链上溯 + 综合打分 ----
    const fused = rrfFuse(ranked, this.rrfK);
    const resolved: Array<{ entry: MemoryEntry; score: number; channels: Channel[]; why: string }> =
      [];
    const takenIds = new Set<string>();
    for (const [id, hit] of fused) {
      const e = byId.get(id);
      if (!e) continue;
      const current = this.resolveCurrent(e);
      if (!current || takenIds.has(current.id)) continue;
      takenIds.add(current.id);
      const base = hit.score;
      const boost = hit.channels.includes("rules") ? 0.5 : 0;
      const score = compositeScore({ base, entry: current, now: this.now(), boost });
      const why = (reasons.get(id) ?? ["fused"]).join(", ");
      resolved.push({ entry: current, score, channels: hit.channels as Channel[], why });
    }
    resolved.sort((a, b) => b.score - a.score);

    // ---- MMR 去冗余 (没有 embedding 时用词集 Jaccard) ----
    const diverse = mmrSelect(
      resolved,
      (h) => h.score,
      (a, b) => jaccardOfSets(tokensOf(a.entry), tokensOf(b.entry)),
      { limit: Math.max(limit * 4, limit + 8), lambda: this.mmrLambda },
    );

    // ---- 预算裁剪 (规则保底) ----
    const budgeted = applyTokenBudget(
      diverse.map((h) => ({
        item: h,
        tokens: estimateTokens(h.entry.content) + 8,
        reserved: h.channels.includes("rules") || h.entry.kind === "rule",
      })),
      tokenBudget,
    );
    const finalHits: RetrievalHit[] = budgeted.kept.slice(0, limit);
    const dropped: RetrievalResult["dropped"] = budgeted.dropped.map((d) => ({
      id: d.item.entry.id,
      reason: "budget",
    }));
    for (const h of diverse) {
      if (finalHits.some((f) => f.entry.id === h.entry.id)) continue;
      if (dropped.some((d) => d.id === h.entry.id)) continue;
      dropped.push({ id: h.entry.id, reason: "filtered" });
    }

    return {
      hits: finalHits,
      tokens: finalHits.reduce((n, h) => n + estimateTokens(h.entry.content) + 8, 0),
      dropped,
      degraded,
    };
  }

  /**
   * 同步向量索引: 优先用存储的"廉价全量投影 + 写版本号"(变了才同步);
   * 存储不支持时退回原来的按查询扫描 (有上限, 会在结果里记 degraded —— 宁可说得清楚, 也不要静默漏)。
   */
  private syncVectorIndex(): void {
    if (!this.vectorIndex) return;
    const indexable = this.source as Partial<IndexableSource>;
    if (typeof indexable.indexDocs === "function" && typeof indexable.revision === "function") {
      const revision = indexable.revision();
      if (revision === this.vectorSyncedRevision) return;
      this.vectorIndex.upsert(indexable.indexDocs());
      this.vectorSyncedRevision = revision;
      return;
    }
    const legacyLimit = 500;
    const candidates = this.source.query({ limit: legacyLimit }).filter((e) => this.keepEntry(e));
    this.vectorIndex.upsert(candidates.map((e) => ({ id: e.id, content: e.content })));
  }

  /** 可见性+范围判定 (抽出来给"无全量投影"的降级路径复用)。 */
  private keepEntry(entry: MemoryEntry): boolean {
    const status = entry.status ?? "active";
    if (status === "shadow" || status === "merged" || status === "expired") return false;
    return true;
  }

  /**
   * 命中演化链上的旧版本时, 返回链上最新的 active 版本 (注入最新, 历史仍可查)。
   * 无链/链尾仍是非 active → 返回原条目 (由 visible() 决定去留)。
   */
  private resolveCurrent(entry: MemoryEntry): MemoryEntry | null {
    if ((entry.status ?? "active") === "active") return entry;
    if (entry.status === "shadow" || entry.status === "expired") return null;
    let current = entry;
    for (let hop = 0; hop < 10; hop++) {
      const next = this.source.traverse(current.id, "supersededBy")[0];
      if (!next) break;
      current = next;
    }
    const status = current.status ?? "active";
    if (status === "shadow" || status === "expired") return null;
    return current;
  }
}
