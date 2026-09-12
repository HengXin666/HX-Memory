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
import type { MemoryEntry } from "../kernel/types.ts";
import { searchableText, termStreams } from "../kernel/cjk.ts";
import { coverage, gatherChannels, queryTerms } from "./channels.ts";
import { compositeScore, rrfFuse } from "../kernel/ranking.ts";
import { assembleHits } from "./assemble.ts";
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
  /**
   * 各通道的 RRF 权重默认值 (缺省 1)。
   *
   * 为什么需要: RRF 只吃排名, 通道之间"谁更该说了算"只能靠权重表达。
   * 实测 (166 个 case, 见 docs/memory-benchmark-report.md): bm25 权重 2 时词面精度最好,
   * 而向量通道的候选没有覆盖率门槛、又常常在同义改写上补召回 ——
   * 让词面占主导、向量做补充的配比明显优于等权。
   */
  channelWeights?: Partial<Record<Channel, number>>;
  /** 覆盖率下限 (0..1): 低于它且命中词数不足的候选被丢弃 (压 bigram 噪声)。 */
  coverageFloor?: number;
  /** 图扩展的默认跳数。 */
  graphHops?: 0 | 1 | 2;
  /**
   * 图候选的独立配额 (第二梯队条数; 默认 3, 0 = 不追加)。
   *
   * 为什么是配额而不是权重: 图候选是"主题邻居"不是"答案" (实测 gold 精确率 8.5%),
   * 按权重参与 RRF 会挤掉词面命中; 但它在字面不可达时确实有用。配额让它"只能补位,
   * 不能抢占" —— 实测同时保住 R@1 (0.684) 与图专属召回 (0.25 -> 0.75)。
   */
  graphTierQuota?: number;
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
/**
 * 默认检索器。同步实现 (SQLite 类引擎足够快), 因此同时满足 Retriever 与 SyncRetriever ——
 * 预步注入不需要额外的投影层; 将来接异步引擎时, 这一层之上再加投影即可。
 */
export class HybridRetriever implements Retriever, SyncRetriever, RetrievalWarmup {
  private readonly channelLimit: number;
  private readonly channelWeights: Partial<Record<Channel, number>>;
  private readonly coverageFloor: number;
  private readonly graphHops: 0 | 1 | 2;
  private readonly graphTierQuota: number;
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
    this.channelWeights = opts.channelWeights ?? {};
    this.coverageFloor = opts.coverageFloor ?? 0.5;
    this.graphHops = opts.graphHops ?? 1;
    this.graphTierQuota = Math.max(0, opts.graphTierQuota ?? 3);
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
    // recall = 显式搜索/面板浏览/意图召回: 规则保底通道默认关闭 (要的是"最相关")。
    // 显式传 channels.rules.enabled 仍可覆盖 —— 目的是改默认, 不是禁掉该通道。
    const recall = req.purpose === "recall";
    const enabled = (c: Channel): boolean =>
      req.channels?.[c]?.enabled ?? (recall && c === "rules" ? false : true);
    // 权重优先取调用方显式值, 其次取构造时的默认表, 最后 1。
    const weightOf = (c: Channel): number =>
      req.channels?.[c]?.weight ?? this.channelWeights[c] ?? 1;

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

    const hops = req.expand?.graph ?? this.graphHops;
    const reasons = new Map<string, string[]>();

    const addReason = (id: string, reason: string): void => {
      const list2 = reasons.get(id) ?? [];
      list2.push(reason);
      reasons.set(id, list2);
    };

    const gathered = gatherChannels(
      {
        source: {
          query: (q) => this.source.query(q as never),
          searchText: (t, l) => this.source.searchText(t, l),
          get: (id) => this.source.get(id),
          traverse: (id, t) => this.source.traverse(id, t),
        },
        caps: this.caps,
        channelLimit: this.channelLimit,
        coverageFloor: this.coverageFloor,
        graphHops: hops,
        ...(this.vectorIndex ? { vectorIndex: this.vectorIndex } : {}),
        enabled,
        weightOf,
        textOf,
        keep,
        qualifies,
        remember,
        addReason,
        syncVectorIndex: () => this.syncVectorIndex(),
      },
      req,
      text,
      terms,
      candidateWindow,
    );
    const ranked = gathered.ranked;
    for (const reason of gathered.degraded) degraded.push(reason);

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
      // boost 同理只在注入语义下给规则 (recall 已关掉该通道; 这里再挡一次显式开启的用例)。
      const boost = !recall && hit.channels.includes("rules") ? 0.5 : 0;
      const score = compositeScore({ base, entry: current, now: this.now(), boost });
      const why = (reasons.get(id) ?? ["fused"]).join(", ");
      resolved.push({ entry: current, score, channels: hit.channels as Channel[], why });
    }
    // 收尾 (去冗余 / 预算 / 图候选补位 / 返回顺序) 抽到 retrieval/assemble.ts ——
    // 它与"取数与融合"的变化原因不同, 混在一个文件里会把两者都撑破。
    const result = assembleHits(
      resolved,
      {
        limit,
        tokenBudget,
        mmrLambda: this.mmrLambda,
        graphTierQuota: this.graphTierQuota,
        tier2Ids: gathered.tier2.flatMap((l) => l.ids),
        tokensOf,
        resolve: (id) => {
          const e = byId.get(id);
          return e ? this.resolveCurrent(e) : null;
        },
        whyOf: (id) => (reasons.get(id) ?? ["graph"]).join(", "),
      },
    );
    result.degraded = degraded;
    return result;
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