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
  GeneralizationRunReport,
  GeneralizationStatus,
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
  /**
   * 按 id 取**单个**条目。
   *
   * ⚠ **可见性口径与列表访问器相反**: 它**不做任何状态过滤** —— `shadow` / `merged` / `expired`
   * 一律能取到 (§783 实测)。
   *
   * 为什么必须如此: 治理动作**先读后写** —— `forget` 要取到条目才能把它置为 `shadow`;
   * `revise` 要取到才能改; `link` 要取到两端才能建边。若这里也过滤 shadow,
   * **撤回过的条目就再也治理不了** (取不到 ⇒ 改不了)。
   *
   * **⇒ 所以消费方要"活着的条目"时必须自己判 `isLiveEntry` (/ `status === "active"`) ——**
   * 那与列表访问器 (`all`/`query`/`recent`/`searchText`) 的默认不同, 是这里最容易踩的一处。
   */
  get(id: string): Awaitable<MemoryEntry | null>;
  query(q: Query): Awaitable<MemoryEntry[]>;
  /**
   * 全量读取: **去重集回填**等需要"扫一遍全部条目"的调用点用它。
   *
   * ⚠ **它不是"把库里所有行给你"** —— 实测 (2026-09-18, §680/§683):
   *   · **排除** `shadow` (撤回的条目不参与检索, 但**真相文件里仍在**);
   *   · **不排除** `merged` / `expired` —— 它们**会**出现在返回值里 (实测确认)。
   *
   * 实现是 `query({ limit: MAX_SAFE_INTEGER })` ⇒ 继承 `query` 的可见性口径
   * (`index-reader.ts`: 默认 `status != 'shadow'`)。
   *
   * **⇒ 消费方必须自己判 `status === "active"`。** 已有的三处都这么做了:
   * `always-on` (非 active 直接 false) / `consolidate` (`!== "active" && continue`) /
   * 而 `codex export` **刻意不过滤** (导出就该含全部)。
   *
   * 为什么把这段话写在端口上 (而不是留给我自己记): 我在 §674/§680 两次按"`all()` = 全部"
   * 下结论, 两次都错 —— 而契约注释当时只说了"不截断", 读起来像"完整集合"。
   */
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
  /** 取最近候选跑一批 (面板/工具的统一触发点); 返回漏斗报告 (面板据此解释"为什么是 0 条")。 */
  runRecent(sourceRun: string, limit?: number): Promise<GeneralizationRunReport>;
  /** 状态视图 (AI 是否可用 / 最近一次批次 / 队列计数)。 */
  status(): GeneralizationStatus;
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
export type Channel = "rules" | "bm25" | "vector" | "graph" | "tag" | "entity" | "recency";

/** 实体通道的调参面 (标定出来的, 见 Agent Note; 默认值由实测选定)。 */
export interface EntityChannelOptions {
  /** 进榜上限: 实体候选的精度低, 长列表会在 RRF 里累积出足以挤掉词面命中的分数。 */
  maxIds: number;
  /** 至少共享几个种子实体才进榜 (1 = 任意共享; 提高到 2 只保留强连接)。 */
  minShared: number;
}

/**
 * 检索源: 引擎必须能提供的最小能力 (存储实现按需扩展)。
 *
 * ⚠ **可见性口径在这三个方法上一致, 而在 `get(id)` 上相反** (§783 实测):
 * `searchText` / `query` 默认排除 `shadow`/`merged`/`expired` (即 `isLiveEntry`);
 * 而 `get(id)` **不过滤** (治理要"先读后写")。**列表与单取的口径不同, 是这里最容易踩的。**
 */
export interface RetrievalSource {
  /** 全文检索 (BM25 优先, LIKE 降级), 返回顺序即相关性顺序。默认排除不可见状态。 */
  searchText(text: string, limit?: number): MemoryEntry[];
  /** 结构化条件过滤。默认排除 `shadow`/`merged`/`expired`; 传 `includeShadow` 放行 `shadow`。 */
  query(q: Query): MemoryEntry[];
  /** 按 id 取: **不过滤** (与 `get` 的端口契约一致 —— 治理需要能取到已撤回的条目)。 */
  get(id: string): MemoryEntry | null;
  /** 关系遍历 (图扩展的基础)。 */
  traverse(fromId: string, relationType: string): MemoryEntry[];
  /**
   * 关系遍历的**反向**方向 (入边): 找出所有**指向** toId 的存活条目。**可选能力**。
   *
   * 为什么需要它 (2026-09-18 实测): 语义边只有「抽象 → 实例」一个方向, 而**用户的提问方向
   * 是反的** ("这个具体的坑, 对应哪条通用规则?")。离线模拟: 4 条从实例细节提问、
   * gold 是短抽象的用例上, 只走出边命中 **0/4**; 加入边后 **3/4**。
   *
   * 与 `byEntities` 同为可选: 缺它时出边扩展**照常工作**, 只是少一个方向。
   */
  traverseIncoming?(toId: string, relationType: string): MemoryEntry[];
  /**
   * 实体反查 (实体倒排; 可选能力, 引擎没有就少一个通道)。
   * 存在理由见 docs/benchmark-review.md §二之二: "字面不可达但共享实体"只能靠它, 写入期建边无解。
   */
  byEntities?(keys: readonly string[], limit?: number): MemoryEntry[];
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
  /**
   * 检索目的: "inject" (默认) 或 "recall"。
   *
   * 为什么要分开: 规则保底通道对**注入**是对的 (跨项目不变量必须永远在场, 见 ADR-006),
   * 但同一个语义被"显式搜索/面板浏览/意图召回"复用后, 前几条永远是那几条规则 ——
   * 规则通道不受覆盖率过滤, 通道权重 1.5 + boost 0.5, 数学上碾压所有字面命中。
   * 规则本来就已由 always-on 通道单独注入, 在这些路径再垫一遍纯属重复占位。
   *
   * "recall" 语义: 关掉规则保底通道与相应 boost, 只按相关性排 ——
   * 调用方要回答的是"哪条记忆最相关"。仍可显式传 channels.rules.enabled 覆盖。
   */
  purpose?: "inject" | "recall";
  /**
   * 覆盖率词表的严格度: "precision" (默认) 或 "candidate"。
   *
   * 为什么需要分开 (2026-09-17 实测, 一次真实的回归): 查询侧的覆盖率词表剔除了虚词与
   * 单字碎片 (见 kernel/function-words.ts), 这对**给模型看的结果**是对的 —— 实测
   * "如何用 Rust 写一个 WebSocket 服务器" 在一条完全无关的条目上得到 cov=0.63, 命中的
   * 全是 用/写/一个 这类词。但同一套门槛也被**写入期的近邻查找**复用 (app/neighbors.ts),
   * 那里要的是"字面沾边就拿来裁决"的召回: 裁决器自己会按 coverage>=0.75 (duplicate) /
   * >=0.5 (supersede) 严格判定。剔除虚词后, 一对真实的同义重述 (上线前做回归测试 /
   * 部署前跑全量回归校验) 只剩一个共享词, 命中数从 2 掉到 1, 近邻查找直接找不到对方 ——
   * 语义去重静默失效 (tests/s2/facade-evolution.test.ts 当场变红)。
   *
   * 结论: **读要精度, 写要召回**, 两者不能共用同一个门槛。默认 "precision" 保持读路径的
   * 精度; 候选生成路径显式传 "candidate" 退回全词表 (即改动前的行为)。
   */
  coverageMode?: "precision" | "candidate";
  /** 双时态切片: "那时为真的是什么" (按 validAt 过滤)。 */
  asOf?: string;
  scope?: { project?: string; lineage?: readonly string[]; global?: boolean };
  /**
   * **本调用要求项目范围**: 给了它且没有工作区上下文时, `scope:"project"` 的条目一律不可见。
   *
   * ⚠ 为什么需要这个开关 (2026-09-27, 真实缺陷): `projectEntryVisible` 在 **scope 缺失时
   * 返回 true (全放行)** —— 那是给**面板 / CLI 搜索**用的语义 (它们是管理面, 用户要看全库)。
   * 但 agent 侧检索不能这样: 实测 `memory_search` 不带 scope 时召回 **7/9 条属于别的项目**
   * (HX-OutlookRegister / HX-Jungle / ds-test), 于是"这个项目定了什么"被别的项目的结论回答。
   *
   * 两者都对, 但**不能共用同一个缺省**: 因此把"我是 agent 检索, 我要项目范围"做成调用方
   * 显式声明的开关, 而不是去改 `projectEntryVisible` 的默认值 (那会同时打断面板/CLI 的全库浏览)。
   * 语义与 `selectAlwaysOn` 一致: **不知道是哪个工作区时, 一条项目内条目都不给**, 而不是全都给。
   */
  scopeRequired?: boolean;
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
  /**
   * 按 id 批量取原文 (溯源链的最后一跳: 记忆条目 → 产生它的那轮对话)。
   *
   * 为什么必须存在: `MemoryEntry.derivedFrom` 存了 episode id, 但此前没有任何按 id 查询的
   * 公开路径 —— 于是"这条结论来自哪一轮对话"在产品层不可回答 (盲审 2026-09-18 指出)。
   * 只提供**批量**形态: 一条记忆天然对应多轮 (user + assistant), 单 id 版本由调用方传单元素数组,
   * 避免同一段逻辑写两遍。找不到的 id 直接缺席返回 (不抛错, 不拿其它内容冒充原话)。
   */
  byIds(ids: readonly string[]): Awaitable<Episode[]>;
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
// 引擎侧端口 (嵌入 / 向量索引 / 派生索引同步面) 拆到 ports-engines.ts ——
// 它们的读者是"要接进来的引擎", 与本文其余端口的读者 (内核编排 / 宿主适配层) 不同。
// 这里 re-export 以保持既有 import 路径不变 (调用方无需改动)。
export type {
  Embedder,
  SyncEmbedder,
  VectorIndex,
  IndexDoc,
  IndexableSource,
} from "./ports-engines.ts";
export { asSyncEmbedder } from "./ports-engines.ts";
