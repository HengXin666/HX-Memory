# 架构 v2: 四层切面 (Surface / Application / Ports / Engines)

> 目的: 定义 HX-Memory 的目标架构 —— 让"换宿主""换存储引擎""换检索算法""换 AI 抽取器"这四类变化各自只触碰**一层**, 且每一层都能全量重建。
> 边界 (不写什么): 不写逐行实现 (在 src 注释与 ADR); 不写使用教程 (在 README); 不写市面方案调研 (在 `docs/open-source-landscape.md`)。
> 与代码的关系: 现状分层见 [architecture.md](architecture.md); 本文的端口落在 `src/kernel/`, 应用服务落在 `src/app/`, 引擎落在 `src/engines/`, 宿主接入落在 `src/surfaces/`; 取舍记录见 [adr.md](adr.md) 的 ADR-015 起。

## 0. 一句话

**记忆系统的可演进性 = 端口切得对不对。** 宿主会换 (DSH → Claude Code → Codex → 任意 MCP 客户端)、引擎会换 (SQLite FTS5 → sqlite-vec → LanceDB → Qdrant; 关系表 → Graphiti/Kuzu)、抽取器会换 (正则 → LLM → 下一代模型)。只要这四类东西都被端口挡住, 换任何一个都只是"新增一个实现 + 跑同一套 conformance 测试", 而不是改造记忆本身。

## 1. 现状 (v1) 的缺陷与归属层

v1 已有正确的骨架 (kernel 零依赖 + Port/Adapter + truth-in-files), 但切面切在"宿主 vs 存储"两条, 应用逻辑与端口职责有混叠。下表把 v1 的每一条已知缺陷定位到**它该由哪一层修**。

| #   | 缺陷 (现状证据)              | 根因                                                 | 归属层          | v2 的修法                                                                |
| --- | ---------------------------- | ---------------------------------------------------- | --------------- | ------------------------------------------------------------------------ |
| 1   | 精确哈希去重, 换个说法就绕过 | `capture/engine.ts` contentHash = sha256(全文)       | 应用层 + 引擎层 | 归一化指纹 (小写/去标点/去空白) + 语义近邻去重 (Embedder 端口) + 裁决器  |
| 2   | 信号词是手写正则, 覆盖窄     | `EXPLICIT_PATTERNS`/`LESSON_SIGNALS`/`RULE_SIGNALS`  | 应用层          | `Extractor` 端口 (LLM/规则两实现); 正则降级为 fallback                   |
| 3   | 中文无分词, 关键词包含评分   | `recall/service.ts` score() = includes()             | 引擎层          | FTS5 + 词/bigram 双流分词 (见 §3.5, 已实测)                              |
| 4   | 无语义检索                   | 无 Embedder                                          | 引擎层          | `Embedder` 端口 + sqlite-vec/LanceDB; 无则降级 BM25                      |
| 5   | 检索被钉死为同步             | `SyncMemoryStore` 进了 Binder/RecallService 构造函数 | 端口层          | `Retriever` 端口 + `RetrieverProjection` (预步读投影)                    |
| 6   | 无 token 预算, 只有条数上限  | `maxTokens` 只是注释里的 advisory                    | 应用层          | 预算分配器 (rules/digest/local 三段配额 + 截断)                          |
| 7   | `supersedes` 链没有写入者    | ADR-005 只落地了语义与读侧                           | 应用层          | `EvolutionService`: 近邻裁决 → 生成 UPDATE/MERGE/SUPERSEDE               |
| 8   | 无遗忘/衰减/强化             | 模型里没有 importance/access 字段                    | 应用层 + 引擎层 | `importance`/`reinforcement`/`lastHitAt` + `expired` 状态 (永不物理删除) |
| 9   | 关联只由 generalizer 写      | `relations` 仅 confirm 时写 generalizes              | 应用层          | `LinkService`: 实体/标签/语义三类建边                                    |
| 10  | 全局规则"总是全量候选"       | `recall` 直接 query 全部 rule                        | 应用层          | 规则同样走检索, 但给**保底配额** (不允许被挤掉)                          |
| 11  | `rebuild` 不在端口里         | `rebuildFromFiles()` 只是 FileBackend 的方法         | 端口层          | `Rebuildable` 端口 + `VerifyReport`                                      |
| 12  | 单宿主深度绑定               | 业务逻辑散在 `adapters/dsh/*`                        | 使用层          | `MemoryFacade` 唯一 API + 多 Surface (DSH/MCP/Codex/HTTP)                |
| 13  | 无观测性 (命中率/污染率)     | 只有 `warnings()`                                    | 应用层          | `MemoryMetrics` + 评测集 (recall@k / 误注入率)                           |
| 14  | 原文丢失, 无法重放           | `context` 从不捕获 ⇒ 轮次原文不留存                  | 引擎层 (真值)   | `Episode` 追加日志: 换抽取器时**重放**而非重聊                           |

> 关键洞察 (第 14 条): 如果只存"抽出来的记忆", 那么抽取器/嵌入模型一旦升级, 老数据只能重抽**已有记忆** (信息已经损失过一次)。存**原文 episode** 之后, 全量重建才覆盖到"抽取"这一级。

## 2. 目标分层

```text
┌──────────────────────────────────────────────────────────────────────────┐
│ L3 使用层 Surfaces            谁在用: DSH / Claude Code / Codex / MCP / HTTP │
│    MemoryFacade (唯一入口 API): remember · recall · revise · forget ·      │
│    link · history · consolidate · proposeRule · stats · export/import      │
├──────────────────────────────────────────────────────────────────────────┤
│ L2 应用层 Application         记忆怎么被加工 (纯逻辑, 零宿主依赖, 可 S1 测) │
│    CaptureService · RecallService · EvolutionService · LinkService ·       │
│    ConsolidationService · GeneralizeService (人工闸门) · Governance        │
├──────────────────────────────────────────────────────────────────────────┤
│ L1 端口层 Ports               一切会被替换的东西都是端口 (本层只有类型)     │
│    TruthStore · DerivedStore · Rebuildable · Retriever · RetrieverProjection│
│    Embedder · Extractor · Reranker · Linker · Clock · Logger               │
├──────────────────────────────────────────────────────────────────────────┤
│ L0 引擎层 Engines             具体实现, 可整体替换 + 全量重建               │
│    真值: Markdown+git │ JSONL │ SQLite │ 远端 HTTP                         │
│    检索: SQLite-FTS5 │ sqlite-vec │ LanceDB │ Qdrant │ Meilisearch          │
│    图  : SQLite relations │ Kuzu │ FalkorDB/Neo4j │ Graphiti               │
│    嵌入: null(降级) │ 本地 ONNX(bge-m3) │ OpenAI/DeepSeek │ 自建服务        │
└──────────────────────────────────────────────────────────────────────────┘
```

依赖方向仍然单向: **L3 → L2 → L1 ← L0**。L0 实现 L1 的接口, L2 只认 L1, L3 只认 L2 的 Facade。任何一层 import 上一层 = bug (由 `tests/s1/architecture.test.ts` 断言)。

### 2.1 L3 使用层: 一个 Facade, 多个 Surface

现状的问题是 **DSH 的工具直接调用 `FileBackend`** (`adapters/dsh/tools.ts` 里 `deps.store.query(...)`), 绕过了 RecallService 的规则闸门与去重; Codex 又各自实现一遍。这是"多宿主"最难维护的形态。

v2 规定: **Surface 只能调用 Facade, 不能 import 任何引擎**。

> 状态 (2026-09): DSH 的三条路 (工具 \`memory_search\`、pre-step 绑定注入、面板 RPC \`recentCaptures/deleteEntry/memoryQuery\`) 已全部走 Facade; 面板搜索因此与工具/MCP/CLI 共用同一条检索语义 (规则保底、覆盖率过滤、token 预算、可见性、撤回写审计理由)。CLI(\`hx-memory\`) 与 MCP 也走 \`openMemoryStack\` 同一份组装。

```ts
// src/app/facade.ts —— 唯一的对外 API (面向上层用例, 不是面向存储)
export interface MemoryFacade {
  remember(input: RememberInput): Promise<RememberResult>; // 显式/隐式落记忆 (含去重裁决)
  recall(input: RecallInput): Promise<RecallResult>; // 混合检索 + 预算裁剪
  revise(id: string, patch: RevisePatch): Promise<void>; // 人工修正 (带审计)
  forget(id: string, why: string): Promise<void>; // shadow, 永不物理删除
  link(a: string, b: string, type: RelationType): Promise<void>;
  history(id: string): Promise<MemoryEntry[]>; // 演化链 (含 superseded 版本)
  consolidate(plan?: ConsolidateRequest): Promise<ConsolidateReport>; // 后台整合
  proposeRule(input: RuleProposalInput): Promise<QueuedProposal>; // 只提议, 不落 rule
  stats(): Promise<MemoryStats>;
  export(format: "jsonl" | "markdown"): AsyncIterable<string>;
  import(stream: AsyncIterable<string>): Promise<ImportReport>;
}
```

| Surface  | 宿主                                             | 形态                                                 | 说明                                          |
| -------- | ------------------------------------------------ | ---------------------------------------------------- | --------------------------------------------- |
| `dsh`    | DeepSeek Harness                                 | cordis 插件: 工具 + `agent/pre-step` 注入 + RPC 面板 | 现有实现迁到 Facade 之上                      |
| `mcp` ✅ | Claude Code / Desktop / Cursor / 任意 MCP 客户端 | MCP server (stdio 已实现; http 待做)                 | **多宿主的事实标准**; 六工具全部映射到 Facade |
| `codex`  | Codex CLI                                        | AGENTS.md 同步 + CLI 子命令                          | 现有实现迁到 Facade 之上                      |
| `claude` | Claude Code                                      | hooks (SessionStart / UserPromptSubmit) + skill      | 与 MCP surface 可共存                         |
| `http`   | 其他/脚本/CI                                     | REST + JSON                                          | 兜底与自动化                                  |

新增宿主 = 写一个 Surface (≤200 行) + 跑宿主契约测试; **不改 L0/L1/L2 任何一行**。

### 2.2 L2 应用层: 六个服务 + 一个治理器

| 服务                   | 职责                                                 | 现状                                   |
| ---------------------- | ---------------------------------------------------- | -------------------------------------- |
| `CaptureService`       | turn → Extractor → 候选条目 (归一化/指纹/双时态)     | 已有 `capture/`, 增加 Extractor 端口   |
| `RecallService`        | 检索 + 融合 + 重排 + 预算裁剪 + 注入格式化           | 已有, 检索部分外移到 `Retriever`       |
| `EvolutionService`     | 去重/冲突/更新/合并 (写入期 + 近实时)                | **新增**                               |
| `LinkService`          | 实体/标签/语义建边, 图扩展                           | **新增**                               |
| `ConsolidationService` | 聚类 → 摘要/反思 → 衰减/过期                         | 部分 (generalize 的聚类可复用)         |
| `GeneralizeService`    | 具体经验 → 候选规则 (人工闸门)                       | 已有, 保持不变                         |
| `Governance`           | 铁律守卫: rule 必须人工确认; 撤回=shadow; 无源不断言 | 已有 (分散在 store/recall), 收敛成一处 |

### 2.3 L1 端口层: 切面清单

| 端口                           | 为什么它必须是端口                                    | 替换成本              |
| ------------------------------ | ----------------------------------------------------- | --------------------- |
| `TruthStore`                   | 真相可能从 Markdown 换成 SQLite/JSONL/远端            | 低 (追加语义简单)     |
| `DerivedStore` + `Rebuildable` | 索引可能从 FTS5 换成 LanceDB/Qdrant                   | 中 (要过 conformance) |
| `Retriever`                    | 检索策略 (BM25/向量/图/RRF/LLM rerank) 是最常变的部分 | 中                    |
| `RetrieverProjection`          | 同步注入点 vs 异步引擎的矛盾                          | 低 (内核自带默认实现) |
| `Embedder`                     | 模型/维度/服务会换; 换模型要全量重嵌                  | 低                    |
| `Extractor`                    | 抽取质量是记忆质量的源头, 一定会换                    | 低                    |
| `Reranker`                     | 可选增强 (无则 MMR)                                   | 低                    |
| `Clock`                        | 双时态/衰减/过期需要可注入时间 (可测性)               | 极低                  |

### 2.4 L0 引擎层: 候选与取舍

| 维度     | 候选                                                                      | 结论                                                                                   |
| -------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 全文检索 | SQLite **FTS5** (built-in)                                                | **默认**。已实测 `node:sqlite` 自带 FTS5/trigram/porter/rtree (SQLite 3.51.3, Node 24) |
| 中文分词 | `Intl.Segmenter('zh-Hans')` 词切分 + CJK bigram 双流                      | **默认**。零依赖, 实测可用 (见 §3.5)                                                   |
| 向量     | `sqlite-vec` (npm 0.1.9, 平台二进制 + `loadExtension`) / LanceDB / Qdrant | 首选 sqlite-vec (同库同事务); 规模化再换 LanceDB/Qdrant                                |
| 图       | SQLite `relations` 表 + 递归 CTE                                          | 默认; 需要多跳/时序图时接 Graphiti (Neo4j/FalkorDB/Kuzu)                               |
| 嵌入     | 无(降级) / 本地 ONNX / 远端 API                                           | 端口化, 默认无; 用户配置后启用                                                         |
| 真值     | Markdown (现状)                                                           | 保留。人可读 + git 可 diff + 删库不丢真相等价于"可全量重建"                            |

## 3. 端口契约 (迁移的物理基础)

### 3.1 真值端口

```ts
export interface TruthStore {
  appendEpisodes(episodes: Episode[]): Promise<void>; // 追加, 永不改写
  upsertEntries(entries: MemoryEntry[]): Promise<void>; // 同 id 原位重写 (status/relations 变更)
  readEntries(): AsyncIterable<MemoryEntry>; // 全量流式 (重建输入)
  readEpisodes(since?: string): AsyncIterable<Episode>; // 重放输入
  readonly root: string; // 人可读位置 (git/审计)
}
```

### 3.2 派生态端口 + 重建

```ts
export interface DerivedStore {
  put(entries: MemoryEntry[]): Promise<void>;
  update(id: string, patch: Partial<MemoryEntry>): Promise<void>;
  remove(id: string): Promise<void>; // 逻辑撤回 (shadow)
  capabilities(): CapabilityManifest;
}
export interface Rebuildable {
  readonly schemaVersion: number; // 不匹配 → 触发重建, 不静默读旧索引
  rebuild(truth: TruthStore, opts?: RebuildOptions): Promise<RebuildReport>;
  verify(truth?: TruthStore): Promise<VerifyReport>; // 索引 ↔ 真相 一致性自检
}
```

**三级重建** (用户诉求"全量数据重建"的完整形态):

| 级别        | 输入            | 输出               | 触发场景                 |
| ----------- | --------------- | ------------------ | ------------------------ |
| T1 索引重建 | 记忆条目 (真相) | 全文/标签/关系索引 | 索引损坏、换 FTS 引擎    |
| T2 抽取重建 | Episode 原文    | 记忆条目 + 关系    | 换 Extractor、改捕获规则 |
| T3 嵌入重建 | 记忆条目        | 向量               | 换 Embedding 模型/维度   |
| T4 整体迁移 | TruthStore 全量 | 新引擎全套派生     | 换存储/检索/图引擎       |

四级的顺序是固定的 `T2 → T1/T3`, 且每一级都要求 **幂等 + 可中断 + 有报告**。

### 3.3 检索端口 + 同步投影 (修复缺陷 5)

```ts
export interface Retriever {
  retrieve(req: RetrievalRequest): Promise<RetrievalResult>;
  capabilities(): RetrievalCapabilities;
}

export type Channel = "rules" | "bm25" | "vector" | "graph" | "tag" | "recency";

export interface RetrievalRequest {
  text?: string;
  asOf?: string; // 双时态切片: "那时为真的是什么"
  scope?: { project?: string; global?: boolean };
  kinds?: MemoryKind[];
  tags?: string[];
  limit?: number;
  tokenBudget?: number; // 缺陷 6
  channels?: Partial<Record<Channel, { weight?: number; enabled?: boolean }>>;
  expand?: { graph?: 0 | 1 | 2 }; // 图扩展跳数
}

export interface RetrievalResult {
  hits: Array<{ entry: MemoryEntry; score: number; channels: Channel[]; why: string }>;
  tokens: number;
  dropped: Array<{ id: string; reason: "budget" | "duplicate" | "stale" }>;
  degraded: string[]; // 能力缺失导致的降级 (可观测, 不是静默)
}
```

**同步判定点的解法** (这是 v1 最硬的架构债): DSH 的 `agent/pre-step` 是同步的, 而向量引擎是异步的。v2 引入投影:

```ts
export interface RetrieverProjection {
  retrieveSync(req: RetrievalRequest): RetrievalResult; // 预步注入读这里, 永不等 IO
  refresh(): Promise<void>; // 事件驱动 + 定时刷新
  status(): { fresh: boolean; ageMs: number; version: string };
}
```

规则: **投影只能加速, 不能改变语义** —— 每次 `refresh()` 必须与 `Retriever.retrieve()` 在同一请求上给出同一集合 (顺序可不同), 由 conformance 测试钉住。投影过期 (超过 `maxStaleness`) 时, 注入必须携带"可能不完整"标记或退回纯规则注入, 不允许静默给旧结果。

### 3.4 能力协商 (换引擎不炸的保险)

```ts
export interface CapabilityManifest {
  readonly engine: string; // "sqlite-fts5" | "lancedb" | ...
  readonly semantic: boolean; // 有向量通道
  readonly graph: "none" | "1hop" | "nhop" | "temporal";
  readonly fullText: "none" | "ascii" | "cjk";
  readonly transactions: boolean;
  readonly asyncOnly: boolean;
  readonly multiProcess: boolean;
  readonly rebuildCost: "cheap" | "moderate" | "expensive";
}
```

应用层按 `capabilities()` 决定行为, 并把降级写进 `RetrievalResult.degraded`:
无 `semantic` → 关闭语义去重与向量召回 (回退 BM25 + 归一化指纹); 无 `cjk` → 注入前提示中文召回受限; `rebuildCost: expensive` → 重建走节流队列而不是启动时同步跑。

### 3.5 检索算法 (默认实现, 已实测)

中文是 v1 最大的检索缺陷: `includes()` 评分既无词形归一, 也无相关性排序。实测结论 (Node 24.15 / SQLite 3.51.3 / `node:sqlite`):

| 结论                                                   | 证据                                                                                                        |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `node:sqlite` 自带 FTS5, 且 trigram/porter/rtree 可用  | `CREATE VIRTUAL TABLE t USING fts5(...)` 全部成功                                                           |
| FTS5 **trigram 无法匹配 2 字中文查询**                 | `MATCH '并发'` → 0 行; `MATCH '并发策略'` → 命中                                                            |
| `Intl.Segmenter('zh-Hans', {granularity:'word'})` 可用 | "所有容器实际上都有并发策略问题" → [所有, 容器, 实际, 上, 都有, 并发, 策略, 问题]                           |
| 分词后写入 FTS5 unicode61 + bm25 排序可召回 2 字查询   | `MATCH '"并发"'` → 命中; `MATCH '"连接池"'...` 命中 "数据库连接池超时设置" (词切分不完全, 故需 bigram 兜底) |

因此默认检索通道是**双流分词**: `tokens = Segmenter 词 + CJK bigram` (例如 "连接池超时" → `连接 池超 超时 连接池 接池超 池超时`), 写入 FTS5 `unicode61` 列, BM25 排序。bigram 兜底让 2 字查询与未登录词都能命中; 词流让 BM25 的文档长度归一不至于被 bigram 噪声压垮。两流分数用 RRF 融合。

**融合与排序** (默认, 逐项可关):

```text
score(entry) = RRF(各通道排名)
             × timeDecay(exp(-λ·age), λ 按 kind 分档)
             × importance(1..10 归一)
             × reinforcement(log(1+hits))     // 命中即强化 (lastHitAt 更新)
             + rulesBoost(已确认规则保底配额)     // 缺陷 10: 规则不允许被挤掉
之后: MMR 去冗余 (λ=0.7) → token 预算裁剪 (rules/digest/local 三段配额) → 注入格式化
```

### 3.6 Conformance: 换引擎的验收协议

`tests/conformance/` 一套参数化测试, 每个引擎实现都要跑同一份:

1. **端口形状**: 实现类 satisfies 各端口 (类型断言, 对齐 `tests/s1/ports.test.ts`)。
2. **往返无损**: 写入 → 全量读回 → 逐字段相等 (含 relations/tags/structured/双时态)。
3. **重建幂等**: `rebuild()` 两次结果一致; 重建后 `verify()` 全绿。
4. **撤回持久**: `remove()` 后重建不复活 (shadow)。
5. **检索契约**: 给定固定语料与固定查询, 召回**集合**必须包含黄金集 (`recall@k ≥ 阈值`); 同请求下投影与直查集合一致。
6. **降级可观测**: 关闭向量通道后, `degraded` 必须非空且结果不抛错。
7. **并发**: 两个进程/两个实例同时读写不炸 (对齐现有 `cross-process` 测试)。

**没有过 conformance 的实现不许进 `src/engines/`** —— 这条规则是"轻而易举换引擎"这句话的唯一保障。

## 4. 关联性与实时更新 (记忆的"活")

### 4.1 领域模型 v2

```ts
export interface Episode {
  // 新增: 原始轮次 (追加日志, 真相)
  id: string;
  session: string;
  turn: number;
  role: "user" | "assistant";
  text: string;
  at: string;
  project?: string;
  surface: string; // 哪个宿主捕获的 (溯源)
}

export interface MemoryEntry {
  // 扩展字段 (★ = v2 新增)
  id: string;
  kind: MemoryKind;
  content: string;
  source: string;
  scope: MemoryScope;
  project?: string;
  ts: Timestamps;
  status?: MemoryStatus;
  relations?: Relation[];
  confirmedBy?: string;
  confirmedAt?: string;
  tags?: string[];
  structured?: { summary: string; points: string[] };
  // ★ 关联性与演化
  entities?: string[]; // 抽取出的实体 (建边用)
  importance?: number; // 1..10, 影响排序与整合优先级
  confidence?: number; // 0..1
  reinforcement?: number; // 被命中次数 (强化)
  lastHitAt?: string; // 衰减基线
  expiresAt?: string; // event/context 类可设 TTL
  derivedFrom?: string[]; // episode id 血缘 (支撑 T2 重放)
  mergedFrom?: string[]; // 合并来源 (可回溯)
}
```

`RelationType` 扩展: `mentions`(条目→实体) · `relates`(权重=共现强度) · `contradicts` · `sameAs`(合并别名) · `derivedFrom` · `instanceOf`(推广的实例侧)。保留 `supersedes`/`supersededBy`/`generalizes`/`appliesTo`。

### 4.2 四级演化流水线

| 级别        | 触发           | 延迟预算 | 做什么                                                                       | 允许 LLM? |
| ----------- | -------------- | -------- | ---------------------------------------------------------------------------- | --------- |
| S1 写入期   | 每次捕获       | < 10ms   | 归一化、精确/指纹去重、标签/实体建边、双时态                                 | 否        |
| S2 近实时   | 队列 + 空闲    | 秒级     | 近邻召回(top-k) → 裁决 ADD/UPDATE/MERGE/SUPERSEDE/CONTRADICT/NOOP → 关系落盘 | 是 (可关) |
| S3 后台整合 | 定时/空闲/显式 | 分钟级   | 聚类 → 摘要 (digest/reflection) → 规则提议(人工闸门) → 衰减/过期/合并        | 是        |

> 状态 (2026-09): S1/S2 的**确定性部分**已落地 (写入期指纹去重 + 候选覆盖率裁决 + 自动建边 + T2 重放); S3 的**确定性部分**也已落地 (\`ConsolidationService\`: 衰减/TTL 扫描 → \`expired\`, 只碰 event/context, 命中过的受保护, 可 revive); 需要 LLM 的部分 (摘要重写/语义合并/冲突裁决) 仍待做, 且必须带闸门。
> | S4 离线重放 | 运维/升级 | 小时级 | episodes → 重抽 → T1/T3 重建 → 一致性报告 | 是 |

**硬约束**: S2/S3 永远不阻塞对话路径; 每个后台批次都有 (条数上限, 时间上限); 所有自动化写入都要在条目上留 `source: "auto:s2" | "auto:s3"` 以便审计与回滚。

### 4.3 冲突消解与"实时更新"

用户诉求"有些内容可能是旧的, 你要会自己更新与整理"落在 S2:

```text
新条目 e_new
  → 候选: Retriever.retrieve({ text: e_new.content, channels: {bm25, vector}, kinds: 同族 })
  → n 个近邻 → 裁决器 (规则优先, LLM 可选):
       同一事实且信息量更大        → UPDATE:  新条目 supersedes 旧, 旧 status=superseded
       同一事实且互补              → MERGE:   合并正文+标签+关系, 旧条目 status=merged, mergedFrom 留痕
       相互矛盾 (时间上后者更晚)   → SUPERSEDE: 同 UPDATE, 额外写 contradicts
       重复 (语义等价)             → NOOP:    只强化旧条目 (reinforcement++, lastHitAt)
       无关联                      → ADD:     新条目独立, 按实体/标签建 relates
```

**注入侧必须立即体现更新**: 命中任一版本节点 → `expandEvolutionChain()` 展开 → **只注入最新 active 版本**, 旧版本仅作为 `history()` 可查 (v1 已有链语义, v2 补上"谁写链")。

**规则 (rule) 是唯一不允许自动演化的种类**: 自动裁决只能提议"某规则可能过时", 落到 review 队列; 改/撤规则永远由人确认 (ADR-003 不破)。

> 状态 (2026-09): 三档全部落地 (ADR-024) —— `duplicate` (指纹/覆盖率 ≥0.75/语义余弦 ≥0.95) 自动强化合并; `supersede` 需"显式更新信号 + 同种类 + 时间不倒退 + 覆盖率 ≥0.5"四条同时成立, 旧条目置 `superseded` + `supersededBy` (不删除); `contradict` 只写双向 `contradicts` 边并保持双方 active。需要 LLM 的语义裁决仍是下一步。

### 4.4 遗忘、衰减与强化

- **衰减**: `decay = exp(-Δdays / halfLife(kind))`; 半衰期按 kind 分档 (event 7d / context 30d / lesson 180d / decision 365d / rule ∞)。
- **强化**: 每次被检索命中并进入注入 → `reinforcement++`, `lastHitAt=now` (半衰期等效延长)。
- **过期**: `decay < 阈值` 且 `reinforcement = 0` → `status: "expired"` (默认只对 `event`/`context`; lesson/decision 永不自动过期, 只降权)。
- **不删除**: `expired`/`shadow` 都留在真相文件; 检索默认不返回, `includeShadow` 可查。**"遗忘"是可逆的降权, 不是数据丢失** (对齐 truth-in-files)。
- **摘要保鲜**: digest 是派生物, 由 S3 重新生成; 新条目到达后旧摘要不"过期", 但会被标记 `staleAfter` 并在下次整合时刷新。

### 4.5 关联的形成 (三种来源)

1. **显式**: 用户/模型调 `memory_link` 或 `remember({ links: [...] })`。
2. **结构**: 同 project/同 tag/同 session/时间邻近 → `relates` (权重=共现次数)。
3. **语义**: 向量近邻 (cosine > 阈值) → `relates` (权重=相似度); 实体共现 → `mentions` + 实体节点上的 `relates`。

> 状态 (2026-09): 结构性建边已落地 (`src/evolution/link.ts`: 标签/实体共现 → 有序 `relates`, 默认上限 3 条, 边进真相可重建); 向量 `relates` 依赖 Embedder 的检索通道 (下一步); 实体节点 (`entity:xxx`) 尚未建, 避免产出查不到的悬空边。

图扩展召回: 命中种子后按 `relates` 做 1-hop (可配 2-hop) 扩展, 权重按 `relation.weight × damping` 衰减, 结果并入 RRF。**扩展不是"多给几条"**: 扩展结果必须带 `why: "graph:from:<seedId>"`, 便于人审计为什么它被召回。

## 5. 使用层: 从"单宿主"到"多宿主"

| 阶段 | Surface                                                                                   | 复用                     |
| ---- | ----------------------------------------------------------------------------------------- | ------------------------ |
| 现状 | DSH (cordis 插件 + 面板)                                                                  | —                        |
| P0   | Facade 抽出, DSH 改为 Facade 消费者                                                       | 全部 L1/L2               |
| P1   | **MCP server** (stdio/http): `memory_search`/`memory_save`/`memory_link`/`memory_history` | Facade 直接映射 MCP tool |
| P2   | Codex (AGENTS.md + CLI) 改为 Facade 消费者                                                | 同上                     |
| P3   | Claude Code hooks + skill                                                                 | 同上                     |
| P4   | HTTP/REST + 导出导入 (CI/迁移用)                                                          | 同上                     |

MCP 优先的原因: 它是 2024 之后多宿主接入的事实标准, 一次实现覆盖 Claude Code/Desktop、Cursor、Cline、Codex 等客户端; 而 hooks 类接入 (DSH/Claude) 只多一层"何时注入"的确定性保证。

## 6. 迁移协议 (换引擎 / 换宿主的操作手册)

**换存储或检索引擎** (以"SQLite FTS5 → LanceDB"为例):

1. 新引擎实现 `DerivedStore` + `Rebuildable` + `Retriever` (或复用通用 Retriever, 只换索引), 声明 `CapabilityManifest`。
2. 跑 `tests/conformance/*` (同一套, 参数化)。
3. `Rebuildable.rebuild(truth)` 从真相全量构建新索引; `verify()` 必须全绿。
4. 影子读: 同一批真实查询, 对比新旧引擎的 recall@k 与延迟, 产出报告。
5. 切换设置项 (`storage.engine = "lancedb"`), 旧索引保留一个版本用于回滚。
6. 回滚 = 改回设置项 + 用真相重建旧引擎索引 (永远可行, 因为真相不在引擎里)。

**换嵌入模型**: T3 重建 (`reembed()`), 向量表带 `model_id`; 维度或模型不一致时拒绝混用并强制重建 (防止"半个库是新模型"的静默错误)。

**换宿主**: 新 Surface 调 Facade; 宿主契约测试 (对齐 ADR-009 的真机门禁思路) 断言: 注入去重、rootAgentsOnly、token 预算、降级可见。

## 7. 分阶段落地与验收

| 阶段                   | 内容                                                                                                                                                                                                                                                                                                                | 验收 (可观察)                                                                                           |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| **P0 切面** ✅         | `MemoryFacade` + 端口 v2 (Retriever/Rebuildable/Capability/EpisodeStore) + `tests/conformance` 套件; DSH 工具/绑定注入/召回共用同一检索语义                                                                                                                                                                         | 314+ 测试全绿; conformance 对两个实现全绿; DSH 真机 smoke 通过                                          |
| **P1 检索** ✅         | FTS5 双流分词 (词+bigram) + BM25 + RRF + token 预算 + 覆盖率过滤 + MMR                                                                                                                                                                                                                                              | 中文 2 字查询有召回 (测试钉住); 预步注入走同一检索器                                                    |
| **P2 演化** ✅(确定性) | ✅ Episode 追加日志 + 指纹/覆盖率/语义余弦三路去重 + 三档演化 (合并/取代/冲突标记, 规则豁免) + 结构建边 + T1/T2 重建 + 命中强化; ⬜ LLM 语义裁决                                                                                                                                                                    | ✅ 换说法重记不重复; ✅ 显式更新自动写取代链且历史可查; ✅ 矛盾双向标记不静默覆盖                       |
| **P3 整合** 🔶         | ✅ 衰减/TTL 扫描 (ConsolidationService, 可干跑可复活) + ✅ 命中即强化 (节流合并); ⬜ LinkService 实体/标签共现建边 + ⬜ digest 刷新 + ⬜ 调度器                                                                                                                                                                     | ✅ 陈旧 event 自动过期且可观测; ✅ 命中即强化有测试; ⬜ digest 随新条目刷新                             |
| **P4 多宿主** ✅       | ✅ MCP stdio surface (六工具, 真机子进程测试) + ✅ Codex CLI (sync/rules/stats/verify/rebuild/consolidate/mcp) + ✅ DSH 面板/工具全走 Facade                                                                                                                                                                        | ✅ 各宿主共用同一 Facade 与检索语义; ⬜ 导出导入 / MCP HTTP 传输                                        |
| **P5 引擎** ✅         | ✅ `Embedder`/`SyncEmbedder` 端口 + 三种实现 (离线词典语义 `LexicalEmbedder` 默认 / 远端 OpenAI 兼容 / 词汇袋基线) + ✅ `VectorIndex` 端口 + `LinearVectorIndex`(同步) 与 `ProjectedVectorIndex`(异步投影) + ✅ 预步硬时限预热 + ✅ 检索与语义质量 conformance; ⬜ 换 ANN 引擎 (sqlite-vec/LanceDB) + ⬜ 图引擎适配 | ✅ 同义改写 Recall@1 20%→80%, Recall@3 20%→100% (10k 条检索 13.7ms); ✅ 换嵌入器/换索引引擎不动业务代码 |

依赖关系: P0 → P1 → P2 → P3 强序; P4 可与 P2/P3 并行; P5 依赖 P1 (通道抽象) 与 P2 (去重语义)。

## 8. 明确不做 (Non-goals)

- **不做多租户 SaaS**: 单用户/单机优先, 多用户是部署形态问题而不是内核问题。
- **不做"全自动规则推广"**: 人工闸门是产品承诺 (ADR-003), 不因能力增强而放开。
- **不把真相搬进引擎**: 引擎永远只是派生; 真相在文件这一条不因换引擎而变 (ADR-002/011)。
- **不追求"记住一切"**: 默认不记忆 (`context` 不落库) 是隐私与信噪比的设计选择; episode 日志可关闭, 且必须可配置保留期。
- **不引入 Python 常驻服务**: 至少到 P5 之前, 所有能力在 Node 内完成 (sqlite-vec 走扩展加载, 不做 sidecar)。

## 相关

- 现状分层: [architecture.md](architecture.md)
- 决策记录: [adr.md](adr.md) (v2 决策从 ADR-015 起)
- 市面方案调研: [open-source-landscape.md](open-source-landscape.md)
