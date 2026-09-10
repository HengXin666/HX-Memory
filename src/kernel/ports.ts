// kernel/ports.ts — the Port interfaces. The kernel depends only on these.
// Implementation decisions (which harness, which storage) live in adapters/ + storage/.
//
// 端口必须是"有实现、可断言"的: FileBackend implements MemoryStore,
// GeneralizerService implements Generalizer, CodexAdapter implements HarnessAdapter。
// tests/s1/ports.test.ts 用类型断言钉住这层关系, 避免端口退化成装饰性文档。
import type {
  Episode,
  EpisodeInput,
  GeneralizationProposal,
  MemoryEntry,
  MemoryEntryInput,
  MemoryKind,
  ProposalStatus,
  QueuedProposal,
  Query,
} from "./types.ts";

/** 同步 (FileBackend) 与异步 (未来的 SQLite/向量后端) 实现都能满足端口。 */
export type Awaitable<T> = T | Promise<T>;

export interface MemoryStore {
  add(entry: MemoryEntryInput): Awaitable<MemoryEntry>;
  get(id: string): Awaitable<MemoryEntry | null>;
  query(q: Query): Awaitable<MemoryEntry[]>;
  /** 全量读取 (不截断): 去重集回填等需要完整集合的调用点。 */
  all(): Awaitable<MemoryEntry[]>;
  /** Walk relations from an entry (e.g. supersedes chain expansion). */
  traverse(fromId: string, relationType: string): Awaitable<MemoryEntry[]>;
  update(id: string, patch: Partial<MemoryEntry>): Awaitable<void>;
  /** 撤回: 索引与真相文件都标记 shadow (可重建后依然不复活)。 */
  remove(id: string): Awaitable<void>;
}

/**
 * 同步查询面。Binder/RecallService 在注入前做**同步**检索 (pre-step 是同步判定点),
 * 因此它们的构造参数要求这个更窄的接口; 异步后端需要自带缓存层。
 */
export interface SyncMemoryStore {
  query(q: Query): MemoryEntry[];
}

/**
 * 适配层需要的**最小存储面**: 比 MemoryStore 多三项"运维/展示"能力, 但依然只依赖端口。
 *
 * 为什么需要它: 适配层 (面板网关、工具、Codex CLI) 此前直接 import `FileBackend` 这个**具体类**,
 * 只为了用 recent / ftsStatus / close —— 这是"端口有缺口"导致的耦合, 会让换存储引擎必须改适配层。
 * 把这三项提成端口上的可选能力后, 适配层只依赖端口 (由 verify-structure 的端口纯度检查强制)。
 * 三项全部可选: 不具备的引擎不必假装支持, 降级由调用方判断 —— 不谎报能力是既有原则。
 */
export interface MemoryOperations extends SyncMemoryStore {
  /** 按 id 取一条 (缺失返回 null)。 */
  get(id: string): MemoryEntry | null;
  /** 写入一条 (端口要求同步: 适配层与预步路径都在同步上下文里)。 */
  add(entry: MemoryEntryInput): MemoryEntry;
  /** 撤回 (默认写 shadow, 永不物理删除)。 */
  remove(id: string): void;
  /** 派生索引状态 (面板展示"是否降级为 LIKE"); 无派生索引的引擎可不实现。 */
  ftsStatus?(): { available: boolean; degraded: string | null; indexed: number; expected: number };
  /** "最近沉淀"视图 (按写入时间倒序); 不实现时调用方可退回 query。 */
  recent?(limit?: number): MemoryEntry[];
  /** 释放资源 (文件/连接句柄)。 */
  close?(): void;
}

export interface Capture {
  raw: string;
  at: string;
  project?: string;
}

export interface Recall {
  entries: MemoryEntry[];
  /** Advisory token budget hint for the harness injection point. */
  maxTokens?: number;
}

export interface SessionContext {
  id: string;
  project?: string;
  origin?: string; // "root" | "subagent" | ...
  header?: Record<string, unknown>;
}

export interface TurnData {
  text: string;
  at: string;
  role: "user" | "assistant";
}

/**
 * Pull 式 harness 端口 (Codex/CLI 这类"请求-响应"宿主)。
 * DSH 是事件驱动宿主, 走 HxMemoryRuntime + Binder + RecallService 的组合, 不实现此端口
 * (见 docs/architecture.md 的"两种接入形态")。
 */
export interface HarnessAdapter {
  readonly name: "dsh" | "codex" | "cli";
  /** What to inject at session start (guidance, not history). */
  onSessionStart(ctx: SessionContext): Promise<unknown>;
  /** Capture a finished turn into memory. */
  onTurnEnd(turn: TurnData): Promise<Capture[]>;
  /** Optional lightweight recall before a step. Return null to inject nothing. */
  onPreStep(step: { text: string; at: string }): Promise<Recall | null>;
  registerTools(registry: { define(name: string, fn: unknown): void }): void;
}

/** 推广端口: 提议 + 队列 + 人工确认。实现必须永不自动写 rule。 */
export interface Generalizer {
  /** Batch-abstract concrete lessons into candidate rules (never auto-confirm). */
  runBatch(sourceRun: string, candidates: MemoryEntry[]): Promise<QueuedProposal[]>;
  /** 取最近候选跑一批 (面板/工具的统一触发点)。 */
  runRecent(sourceRun: string, limit?: number): Promise<QueuedProposal[]>;
  listQueue(status?: ProposalStatus): QueuedProposal[];
  /** 人工确认 (异步: 存储端口允许异步后端)。 */
  confirm(id: string, by: string): Promise<{ ok: boolean; ruleId?: string; error?: string }>;
  reject(id: string): void;
}

/** 单簇抽象端口 (LLM 或启发式)。 */
export interface Abstractor {
  abstract(cluster: { theme: string; contents: string[]; sources: string[] }): Promise<{
    rule: string;
    confidence: number;
  }>;
}

export type { GeneralizationProposal };
// ---------------------------------------------------------------------------
// v2 检索端口 (见 docs/architecture-v2.md §3.3)
//
// 为什么检索要独立成端口: v1 把"检索"钉在 MemoryStore.query 上, 并且要求**同步**
// (Binder/RecallService 的构造函数要 SyncMemoryStore)。于是任何异步引擎 (向量服务/远端库)
// 都接不进来。v2 的切法是: 存储只负责"存与取", 检索负责"找与排", 同步注入点读投影。
// ---------------------------------------------------------------------------

/** 召回通道: why 的可读来源, 也是权重配置的键。 */
export type Channel = "rules" | "bm25" | "vector" | "graph" | "tag" | "recency";

/** 检索源: 引擎必须能提供的最小能力 (存储实现按需扩展)。 */
export interface RetrievalSource {
  /** 全文检索 (BM25 优先, LIKE 降级), 返回顺序即相关性顺序。 */
  searchText(text: string, limit?: number): MemoryEntry[];
  /** 结构化条件过滤。 */
  query(q: Query): MemoryEntry[];
  get(id: string): MemoryEntry | null;
  /** 关系遍历 (图扩展的基础)。 */
  traverse(fromId: string, relationType: string): MemoryEntry[];
  /** 可选: 引擎自述能力 (检索器据此决定降级策略与 degraded 说明)。 */
  capabilities?(): RetrievalCapabilities;
}

/** 引擎能力自述: 上层据此决定"能做什么/降级什么", 而不是猜。 */
export interface RetrievalCapabilities {
  engine: string;
  /** 有真正的全文索引 (BM25) 还是 LIKE 宽召回。 */
  fullText: boolean;
  /** 中文分词可用 (2 字查询可召回)。 */
  cjk: boolean;
  /** 有向量通道。 */
  semantic: boolean;
  /** 图扩展能力。 */
  graph: "none" | "relations";
  /** 是否支持多进程共享 (SQLite 是; 纯内存引擎不是)。 */
  multiProcess: boolean;
}

export interface RetrievalRequest {
  /** 当前任务文本 (用户最近一条消息 / 会话首条)。 */
  text?: string;
  /** 双时态切片: "那时为真的是什么" (按 validAt 过滤)。 */
  asOf?: string;
  scope?: { project?: string; global?: boolean };
  kinds?: MemoryKind[];
  tags?: string[];
  /** 条数上限 (与 tokenBudget 同时生效, 谁先到谁生效)。 */
  limit?: number;
  /** 注入预算 (token); 预算裁剪优先保留 reserved 组 (已确认规则)。 */
  tokenBudget?: number;
  channels?: Partial<Record<Channel, { weight?: number; enabled?: boolean }>>;
  /** 图扩展跳数 (默认 1; 0 = 关闭)。 */
  expand?: { graph?: 0 | 1 | 2 };
  /** 是否包含已撤回/过期 (默认 false; 面板/审计场景打开)。 */
  includeHidden?: boolean;
}

export interface RetrievalHit {
  entry: MemoryEntry;
  score: number;
  /** 命中路径 (可审计: 为什么它被召回)。 */
  channels: Channel[];
  why: string;
}

export interface RetrievalResult {
  hits: RetrievalHit[];
  /** 估算注入 token。 */
  tokens: number;
  dropped: Array<{ id: string; reason: "budget" | "duplicate" | "filtered" }>;
  /** 能力缺失导致的降级说明 (空数组 = 全能力)。 */
  degraded: string[];
}

export interface Retriever {
  retrieve(req: RetrievalRequest): Awaitable<RetrievalResult>;
  capabilities(): RetrievalCapabilities;
}

/**
 * 同步查询面: 预步 (agent/pre-step) 是同步判定点, 不能等 IO。
 * 异步引擎需要自带投影层 (RetrieverProjection) 来满足它。
 */
export interface SyncRetriever {
  retrieveSync(req: RetrievalRequest): RetrievalResult;
}

/** 可注入时钟 (双时态/衰减/过期的测试确定性)。 */
export interface Clock {
  now(): string;
}

/**
 * 检索预热端口 (可选能力)。异步嵌入器的向量由后台补齐, 宿主可以在**注入前带硬时限**地热身:
 *   await warmup(50) —— 最多等 50ms, 补多少算多少, 永不阻塞对话。
 * 同步引擎 (FTS/本地哈希) 不需要实现它 (没有它 = 已经就绪)。
 */
export interface RetrievalWarmup {
  /**
   * 在 deadlineMs 内尽量补齐投影; 超时/未就绪都不算失败 (调用方只需知道"尽力了")。
   * query 用于把"这一轮要查的文本"一起嵌好 —— 否则首轮查询注定没有语义召回。
   */
  warm(deadlineMs: number, query?: string): Promise<void>;
  /** 是否已就绪 (未就绪时注入结果会带降级说明)。 */
  ready(): boolean;
}
/**
 * Episode 存储端口 (ADR-018): 原始轮次的追加日志, 是真相的一部分。
 * 为什么需要它: 记忆是"抽取"的产物, 抽取器一定会升级; 只存抽取结果的话,
 * 升级时只能对已经损失过一次信息的结果再抽一遍, 而"全量重建"也就到不了最上游。
 * 硬约束: 追加写, 永不改写; 可配置保留期; 可整体关闭 (隐私)。
 */
export interface EpisodeStore {
  append(input: EpisodeInput): Awaitable<Episode>;
  /** 全量 (按 at 升序); 重放 (T2 抽取重建) 的输入。 */
  all(): Awaitable<Episode[]>;
  /** 只取某个时间点之后的 (增量重放)。 */
  since(iso: string): Awaitable<Episode[]>;
  bySession(session: string): Awaitable<Episode[]>;
  count(): Awaitable<number>;
  /** 按保留期清理; 返回删除的 episode 数 (0 = 未配置保留期, 不清理)。 */
  prune(nowIso?: string): Awaitable<number>;
}
/**
 * 派生索引的自述与重建能力 (ADR-020 / ADR-023)。
 * 引擎准入的硬条件: 必须能"从真相全量重建", 并且能自证"索引与真相一致"。
 * 没有这两个能力的实现, 不许进 src/storage/ 或 src/engines/。
 */
export interface VerifyReport {
  ok: boolean;
  /** 真相 (文件/上游真值) 里的条目数。 */
  truth: number;
  /** 结构化索引里的条目数。 */
  index: number;
  /** 全文索引里的条目数 (无全文索引时为 undefined)。 */
  fullText?: number;
  problems: string[];
}

export interface Rebuildable {
  /** 派生 schema/身份版本 (如 "format2+tokenizer1"); 不符即重建, 不许混用 (ADR-023)。 */
  readonly schemaVersion: string;
  /** 从真相全量重建派生索引 (T1), 幂等; 返回重建的条目数。 */
  rebuildFromTruth(): Awaitable<number>;
  /** 一致性自检 (索引 ↔ 真相)。 */
  verify(): Awaitable<VerifyReport>;
}
/**
 * 嵌入端口 (ADR-023 的向量侧): 把文本映射成定长向量, 用于语义相似/语义去重/向量召回。
 * 为什么先定义端口再谈引擎: 换模型 = 换一个实现 + 全量重嵌 (T3), 而不是改业务代码;
 * 索引侧必须记录 embedding 身份 (modelId + dim), 不符即重建。
 */
export interface Embedder {
  /** 身份串 (如 "lexical-v1" / "bge-m3@1024"): 进索引身份, 防止混用两种向量。 */
  readonly id: string;
  readonly dim: number;
  /** 批量嵌入 (顺序与输入一致)。 */
  embed(texts: readonly string[]): Awaitable<number[][]>;
  /**
   * 推荐的余弦下限 (**由各嵌入器按自己的分数分布标定**)。
   * 为什么必须由嵌入器声明: 不同模型的相似度尺度完全不同 —— 词汇级嵌入的同义改写约 0.2-0.5,
   * 而真语义模型同一对可能 0.7+; 用一个全局阈值必然有一边失效 (实测过)。
   */
  readonly floor?: number;
}
/**
 * 同步嵌入面。预步注入 (agent/pre-step) 是同步判定点, 不能等 IO ——
 * 本地实现 (哈希袋/常驻 ONNX) 可以直接满足它; 远端 API 类嵌入器做不到,
 * 那种情况走投影 (RetrieverProjection): 后台刷新向量, 预步读缓存 (见 architecture-v2 §3.3)。
 */
export interface SyncEmbedder extends Embedder {
  embedSync(texts: readonly string[]): number[][];
}

/** 能力探测: 只有 embedSync 存在的嵌入器才能进同步检索通道。 */
export function asSyncEmbedder(embedder: Embedder): SyncEmbedder | null {
  const candidate = embedder as Partial<SyncEmbedder>;
  return typeof candidate.embedSync === "function" ? (candidate as SyncEmbedder) : null;
}

/**
 * 向量索引端口 (ADR-023 的向量侧): 近邻检索必须能"换引擎 + 全量重建"。
 * 默认实现是内存线性扫描 (LinearVectorIndex, 见 src/retrieval/vector.ts);
 * 规模上来后换成 sqlite-vec / LanceDB / Qdrant —— 只实现这个端口, 检索层不改。
 * 身份 (embedderId/dim) 必须进索引: 换模型就得重建, 不许混用 (HippoRAG 的 index_manifest 同款)。
 */
export interface VectorIndex {
  readonly embedderId: string;
  readonly dim: number;
  /** 写入/更新 (幂等: 同 id 覆盖; 内容未变时不重复嵌入)。只吃 id+content 的廉价投影。 */
  upsert(docs: readonly IndexDoc[]): void;
  remove(id: string): void;
  clear(): void;
  /** 近邻检索: 返回 id + 余弦分 (降序)。 */
  search(query: string, limit: number): Array<{ id: string; score: number }>;
  size(): number;
  /**
   * 可选: 异步补齐向量 (异步嵌入器的投影)。
   * 同步检索 (预步注入) 只读投影; 宿主在注入前可带**硬时限**地 await 它, 没就绪就降级。
   */
  refresh?(): Promise<void>;
  /**
   * 可选: 提前登记"下一次要查的文本", 让 warm() 能在同一次限时窗口里把它一起嵌好。
   * 没有它也能工作, 只是**第一轮**查询注定没有语义召回 (查询向量要等下一轮才就绪)。
   */
  prime?(query: string): void;
  /** 可选: 投影是否已就绪 (未就绪时检索会记 degraded, 不静默)。 */
  readonly ready?: boolean;
}
/** 索引同步用的最简条目投影 (只要 id + 正文, 不做 relations/tags 的二次查询)。 */
export interface IndexDoc {
  id: string;
  content: string;
}

/**
 * 派生索引 (向量/FTS) 的同步面。为什么单独定义:
 * 按查询去"扫一批候选"在万级下必然漏 (这正是本项目实测到的 bug: 5000 条只索引到 519 条)。
 * 正确做法是"全量投影 + 版本号变更时才同步", 且投影必须是**廉价查询** (单条 SQL, 不 hydrate)。
 */
export interface IndexableSource {
  /** 全量投影 (单次查询; 必须排除 shadow, 但可包含 merged/expired 由索引层决定是否使用)。 */
  indexDocs(): IndexDoc[];
  /** 单调递增的写版本号: 变了才需要重新同步索引 (稳态查询零开销)。 */
  revision(): number;
}
