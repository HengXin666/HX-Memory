# ADR (架构决策记录)

> 只记需要留痕的决策。一条 ADR: 背景 → 选项 → 决策 → 后果。被替换的 ADR 用 supersedes 链接 (呼应产品自身的 supersedes 语义)。

## ADR-001: 自维护内核 + adapter, 不整包引入市面项目

- **背景**: 需要长期自维护的记忆层; 直接引 ReMe/StrataGate 等会带来 peer 依赖、Python 服务、版本漂移与不可控数据格式。
- **选项**: (a) 选用市面最接近的 ReMe 做二次开发; (b) 薄内核自维护, 外部只做设计思想来源; (c) 从零什么都写。
- **决策**: (b)。抄思想不抄代码; 只有这样才能同时满足自维护 + 可插拔 + 安全感的诉求。
- **后果**: 初期实现量大; 换来零外部依赖漂移 + 完全可控的数据格式。

## ADR-002: 真相在文件 (Markdown), 索引在库 (SQLite/向量), 可重建

- **背景**: 文件即记忆利于人读/审计/git 版本; 但纯文件检索慢, 需要索引。
- **选项**: (a) 全存 SQLite; (b) 文件真相 + 派生索引; (c) 全存向量库。
- **决策**: (b)。文件是 git 可 diff 的事实源; SQLite/向量只存派生索引, 删除可重建。
- **后果**: 写入路径多一步索引维护; 换取可审计性与灾难恢复 (删库不丢真相)。

## ADR-003: 推广引擎 = 后台提议 + 用户 review 队列 (人工闸门)

- **背景**: 用户确认推广触发时机选 (a): 后台自动聚类提议, 攒一批统一 review, 不打断会话。
- **选项**: (a) 后台提议 + review 队列; (b) 会话中当场问; (c) 每周批量。
- **决策**: (a)。机器批量聚类+抽象, 用户集中确认; 防幻觉式过度推广。
- **后果**: 推广延迟 (非实时); 换来每一条跨项目规则都经过人。

## ADR-004: 双时态 `validAt` + `assertedAt`

- **背景**: 回答"以前是什么/何时生效"需要时间切片; 单时间戳无法表达"这条 3 月前写、记录 5 月前的事实"。
- **决策**: 每条记忆两时间戳; 检索与演化按 `validAt` 切片 (呼应 HXLoLi ai-docs 004 笔记的双时态约定)。

## ADR-005: supersedes 演化链 (版本化记忆, 借鉴 Hy-Memory 的已验证实现思路)

- **背景**: "覆盖不丢史, 并列不碎片"需要记忆对象可版本演化。
- **决策**: 新节点 supersedes=[旧], 旧节点 superseded_by=[新] + status=SUPERSEDED, 双向指针; 命中任一节点展开整链。代码自维护, 不引入 Hy-Memory 包。

## ADR-006: 前后端全 TypeScript, 前端嵌入 DSH 宿主 Web

- **背景**: 需要给人工闸门一个可视化 review 界面; 需决定前端技术栈与部署形态。
- **选项**: (a) 独立部署 Web 服务 + 后端 API; (b) 前端 React/TSX 嵌入 DSH 宿主 Web (经 dsh-client-* inject + TypertRemoteService); (c) 纯 CLI。
- **决策**: (b)。后端 = TS 内核 + adapter + 存储 (node:sqlite); 前端 = React/TSX 打包进宿主 (dsh.client 元数据 + esbuild bundle), 无独立部署。可选 Python 只做向量检索 sidecar, 作为可插拔存储 adapter 之一。
- **后果**: 不引入第二套部署; UI 能力受宿主 slot 约束 (settings.section); 换宿主时前端 inject 点需重接。

## ADR-007: project 作为第一等公民字段 (跨项目隔离与生效的基础)

- **背景**: scope:"project" 只表达"属于某个项目"却不知道"哪个项目", 导致 A 项目经验泄漏到 B 项目召回。
- **选项**: (a) 从 source 字符串解析项目; (b) MemoryEntry.project 独立字段全链路持久化。
- **决策**: (b)。类型 → 捕获 → 存储 schema → 文件 frontmatter → 查询过滤全链路带 project; 召回按 project 隔离本地经验, 全局规则跨项目生效。
- **后果**: 模式加一列/一字段; 换来召回隔离正确 + "跨项目规则生效"可证。

## ADR-008: "何时读记忆"由声明式绑定 + 确定性注入决定, 不依赖模型自觉 (VCP 式)

- **背景**: 用户指出"让模型自己判断要不要调 memory_search"是概率性行为 — 模型是概率机, 工具调用不稳定; 该搜时不搜 (幻觉自足), 不该搜时乱搜。调研 VCPToolBox (lioensky/VCPToolBox) 后确认其理念: RAGDiaryPlugin manifest "通过向量检索动态地将日记内容注入到系统提示词中", Agent/*.txt 声明记忆拓扑 ([[xx日记本::Time::Group::TagMemo]]), processMessages 代码判定占位符有无, 有绑定即每轮确定性检索注入 (无绑定走零开销快速路径)。
- **选项**: (a) 维持旧线: guidance 指引 + memory_search 工具 (ReMe/ADK 派); (b) 纯自动每轮注入全部规则 (贵且噪声); (c) 声明式绑定 + 确定性预步注入 (VCP 派)。
- **决策**: (c) 为主, (a) 的工具通道保留为补充 — 与 VCP Agent 同时有绑定 + 主动检索一致。落到 kernel/binder.ts: MemoryBinding (查询条件/权重/条数/信号词门控) + BindingConfig (项目级拓扑) + Binder.injectFor (代码判定注入)。
- **后果**: 声明绑定的项目获得 100% 注入保证 (测试: 旧线 10 轮 6 轮命中 vs 新线 10/10); 未声明项目零开销。检索质量仍受关键词评分限制 (后续 VectorBackend 可插拔)。
- **实现注记 (2026-09)**: 注入点从 session-start 深化到 `agent/pre-step` (对照 `@deepseek-ai/dsh-agent-instructions` 的 waterfall 契约: `next()` → 在 lastClaimedIndex+1 处追加 `createUserMessage` 上下文), 每步用**最新用户文本**做绑定检索, 内容级去重防重复注入, rootAgentsOnly 过滤 subagent。绑定配置经 BindingStore 持久化到 root/bindings.json, 面板 (settings.section) 实时编辑即生效。测试: binding-store 4 + prestep 6。

## ADR-009: 宿主契约必须真机验证 (行为门禁, 不是"能启动")

- **背景**: 插件在真机上"装得上、进程不崩、fiber active", 但两个 Web 面板整块不可用 —— 三个原因都不在业务逻辑里: patch 的 `isolate` 让服务在 root ctx 不可见 (宿主 Typert gateway 的 SRC 扫描拿不到 → `/api/hxMemory/*` 全 404); client bundle 硬编码了错误的模块 id (宿主 loader 要求注册 id == boot graph 行 id == 包名); 客户端把 RPC 写成了 `call("hxMemory", "reviewQueue", "proposed")` (真实约定是 `call("/api", "hxMemory/reviewQueue", { args })` + 解包 `{ok,value}`)。
- **选项**: (a) 只保留"启动不崩"冒烟; (b) 用 mock 宿主测 RPC; (c) 真机装插件 + 起 web host + 逐条断言。
- **决策**: (c)。`scripts/smoke-dsh.sh` 在隔离 `DSH_HOME` 里跑: 组合 profile → 启 host → 断言两个 fiber active → 断言 6 个 RPC 端点返回 `ok:true` → 断言 bundle 模块 id 与 boot manifest 行 id 一致。CI 的 `boot-smoke.yml` 只跑这个脚本。
- **后果**: CI 需要网络与 DSH 安装 (慢几十秒); 换来"面板真的能用"这件事有自动化证据。

## ADR-010: `project` 键 = 会话工作目录名 (不是 session id)

- **背景**: 早期实现用 `agent.session.id` (UUID) 当项目键, 于是自动捕获永远 `scope:"agent"`、绑定面板让用户填的项目名无从填写、项目内召回永远为空 —— "项目隔离"只存在于类型里。
- **选项**: (a) 继续用 session id; (b) 用 cwd 的目录名; (c) 用 git 仓库根。
- **决策**: (b)。`projectOfSession()` 取 `session.header.cwd` 的目录名, 捕获 (scope/project) → 绑定 (BindingConfig.project) → 召回 (Query.project) 全链路一致。
- **后果**: 同一目录名在不同路径下会合并 (可接受); 换仓库根方案需解析 `.git`, 留给后续。

## ADR-011: 真相 → 索引必须无损往返

- **背景**: 索引曾被当作"可重建的派生物", 但 `rebuildFromFiles()` 丢 relations (演化链/推广关联消失), 同一 id 二次写入只替换 frontmatter 而把旧正文留在文件里 (真相文件被写坏), `remove()` 只改索引导致重建后撤回的记忆复活。
- **选项**: (a) 索引里存全部语义, 重建只做尽力而为; (b) 文件里存全部语义, 重建必须无损。
- **决策**: (b)。`entryToMarkdown` 写 relations/tags/structured, `parseSingleBlock` 全部读回; upsert 用"下一个块首或文件末尾"精确切片 (不能依赖带 `/m` 的 `$`); `remove()` 在文件里写 `status: shadow`。`tests/s2/file-store-integrity.test.ts` 钉住这四条。
- **后果**: 真相文件稍长; 换来"删库不丢真相"这句话是真的。

## ADR-012: AI 增强用 `ctx.llm.stream`, 不用 `ctx.agents.create`

- **背景**: 记忆结构化/规则提炼只需要"一次文本进、一次文本出"。最初用 `agents.create` 造最小 agent, 但 agent 拥有工具面、会产生自己的会话事件; 本插件在根级监听 `session/event`, 于是子会话的 user/message 被再次捕获 → 递归调用 + 会话文件污染。复核还发现 0.1.2-rc.1 上 `Session.events` 已被移除, 该路径会静默退化成启发式。
- **选项**: (a) 继续用 agents + `origin:"subagent"` + 工具限制; (b) 改用第一方一次性调用 `ctx.llm.stream({provider, model, messages, system, maxTokens, signal})` (dsh-session-title-llm 的做法)。
- **决策**: (b)。无 agent、无工具、无会话事件; provider/model 从 `agentDefaultModel` 取, 取不到就回退启发式。
- **后果**: AI 增强不再是"另一个会话"; 超时由本地 deadline 强制拒绝 (不依赖流实现配合 abort)。代价是拿不到 agent 的工具能力 —— 而这本来也不需要。

## ADR-013: 会话事件读取必须跨 DSH 版本 + 按 surface 过滤

- **背景**: 0.1.1-rc.2 的 `Session.events` 在 0.1.2-rc.1 被移除 (改为 `eventAt/snapshotEvents/ownEvents`)。直接读 `events` 会在目标版本上静默拿到 undefined: 跨 step 去重失效 (每步重复注入), AI 读不到输出。另一方面, compaction 会遮蔽 (shadow) 被替换的事件 —— 它们仍在日志里但已不在模型可见的 surface 上, 按日志判断"注入过"会让模型看不见记忆却永远不再注入。
- **决策**: 新增 `src/adapters/dsh/session-events.ts`: 优先 `eventAt(surface.nodes)`, 退到 `snapshotEvents()` → `events` → `ownEvents()`, 并统一按 `surface.nodes` 过滤可见性。`tests/s2/session-events.test.ts` 覆盖四种形状。
- **后果**: 版本差异集中在一处; 测试用"只带 snapshotEvents 的 fake"防止再次假通过。

## ADR-014: 宿主设置的双路径接入 (installSection / register)

- **背景**: 设置命名空间只有注册了才会出现在 `settings.describe` 里。0.1.2-rc.1 的入口是 `installSection(owner, ns, schema, entry, hooks)` (hooks 交出权威配置 thunk); 0.1.1-rc.2 没有这个方法, 只有 `register(ns, schema, { base })` 返回 `scope.get()`。此前只实现前者, 导致 0.1.1 上设置命名空间根本不出现 (真机门禁发现)。
- **决策**: 能力探测: 有 `installSection` 用 `installSection` 并 `adopt(() => current())`; 否则用 `register` 并 `adopt(() => scope.get())`; 两者都没有才退回组合配置并告警。`scripts/smoke-dsh.sh` 断言 `settings.describe` 一定包含 `hx-memory`。
- **后果**: 两个宿主版本上设置都真的生效; 代价是适配层多一个分支 (由 smoke + settings-adoption 测试覆盖)。

## ADR-015: 四层切面 (Surface / Application / Ports / Engines), 依赖方向单向

- **背景**: v1 只切了"宿主 vs 存储"两条线, 于是业务逻辑散在 `adapters/dsh/*` (DSH 工具直接调 `FileBackend`), Codex 又各写一遍; 换宿主/换检索引擎都要动记忆本体。
- **选项**: (a) 继续按"宿主 adapter"分文件; (b) 按"变化频率"切四层: 使用层 (多宿主) / 应用层 (记忆加工) / 端口层 (可替换物) / 引擎层 (实现)。
- **决策**: (b)。端口层集中"一定会换的东西" (TruthStore/DerivedStore/Rebuildable/Retriever/Embedder/Extractor/Reranker/Clock); 应用层只认端口; 使用层只认 Facade。依赖方向 `L3 → L2 → L1 ← L0` 单向, 由 `tests/s1/architecture.test.ts` 断言。
- **后果**: 新增宿主 = 写 Surface, 不改内核; 代价是"多一层间接", 小改动也要想清楚它属于哪一层 (见 [architecture-v2.md](architecture-v2.md))。

## ADR-016: 检索独立成端口 (Retriever), 同步判定点用投影解决

- **背景**: v1 把检索钉在 `MemoryStore.query` 上, 而且要求**同步** (`SyncMemoryStore` 进了 Binder/RecallService 的构造签名)。后果: ①任何异步引擎 (向量服务/远端库) 接不进来; ②排序策略 (关键词包含评分) 与存储实现绑死, 换引擎等于换排序语义。
- **选项**: (a) 让所有调用点改成 async; (b) 保留同步注入点, 引入 `Retriever` 端口 + `RetrieverProjection` (预步读投影, 后台刷新)。
- **决策**: (b)。默认实现 `HybridRetriever` 是同步的 (SQLite 足够快), 因此同时满足 `Retriever` 与 `SyncRetriever`; 将来接异步引擎时在它之上加投影, 不改调用点。投影的硬约束: **只能加速, 不能改变语义** (同请求同集合, 由 conformance 钉住); 过期必须显式标记降级。
- **后果**: Binder/RecallService/工具三条路共用一次检索语义; 老的关键词路径保留为无 Retriever 时的回退 (不是长期形态)。

## ADR-017: 全文索引默认 FTS5 + "词 + CJK bigram" 双流分词

- **背景**: v1 的检索评分是 `content.includes(词)` 计数 —— 没有词形归一、没有相关性排序、中文无分词。实测 (Node 24.15 / SQLite 3.51.3 / `node:sqlite`): FTS5 自带且 trigram/porter/rtree 可用, 但 **trigram 无法匹配 2 字中文查询** (`MATCH '并发'` → 0 行), unicode61 又把连续汉字当一个 token。
- **选项**: (a) 引入 jieba 类分词依赖; (b) 只用 trigram (放弃 2 字查询); (c) `Intl.Segmenter` 词流 + CJK bigram 流双列, 交给 unicode61, BM25 列权区分。
- **决策**: (c)。零依赖, 且"任意 2 字中文查询可召回"是确定性的; 代价是索引膨胀 2-3 倍与 bigram 宽召回 (噪声由检索层的覆盖率过滤 + MMR 压住)。
- **后果**: 索引带 `tokenizer_version`; 版本不一致时**必须重建**而不是混用 (混用 = 静默召回失真)。规则 (rule) 的确认闸门在检索侧再校验一次。

## ADR-018: Episode 原始轮次是真相的一部分 (支撑抽取级重建)

- **背景**: 记忆是"抽取"的产物, 而抽取器一定会升级 (手写正则 → LLM → 下一代模型)。v1 只存抽取结果, 且 `context` 类**从不落盘**, 于是原文消失; 升级抽取器时只能对已经损失过一次信息的结果再抽一遍。
- **选项**: (a) 只存抽取结果 (现状); (b) 存原文 episode (追加日志) + 抽取结果, 二者用 `derivedFrom` 关联。
- **决策**: (b)。Episode 是追加写、永不改写的真相; 全量重建因此分四级: T1 索引重建 / **T2 抽取重建** / T3 嵌入重建 / T4 整体迁移。
- **后果**: 多一份原始日志的存储与隐私责任 → 必须可配置保留期与关闭开关; 换来"换抽取器 = 重放, 而不是重聊"。

## ADR-019: 演化字段进真相文件; 遗忘是状态而不是删除

- **背景**: 关联性 (entities/relations)、演化 (supersedes/mergedFrom)、衰减 (importance/reinforcement/lastHitAt) 决定记忆怎么被更新与整理。若只存索引, "删库重建/换引擎" 会静默丢掉这些语义 (违反 ADR-011)。
- **选项**: (a) 演化状态只存索引 (承认是有损派生); (b) 全部写进真相文件 frontmatter 并往返无损。
- **决策**: (b)。新增可选字段全部进 frontmatter; `status` 扩展出 `merged`/`expired`; **遗忘 = 状态降权 (可复活), 永不物理删除**; 手工编辑出的坏值只丢该字段并记 warning (不让整条记忆消失), 但状态/时间戳这类语义开关仍 fail-closed 整条拒绝。
- **后果**: 真相文件变长; 换来"删索引/换引擎不丢演化历史", 且人可以直接读/改 (`tests/s2/evolution-fields.test.ts` 钉住往返无损)。

## ADR-020: 引擎准入 = conformance 套件 (没过的实现不进 `src/engines/`)

- **背景**: "存储/检索引擎可插拔, 将来轻松迁移"这句话, 如果没有统一验收, 每次迁移都会变成一次考古。
- **决策**: `tests/conformance/` 一套参数化测试 (端口形状 / 往返无损 / 重建幂等 / 撤回持久 / 检索黄金集 / 降级可观测 / 并发)。任何新引擎必须先过这套测试; 迁移流程固定为"实现端口 → 过 conformance → 从真相全量 rebuild → 影子读对比 → 切换设置项 → 旧引擎保留一版可回滚"。
- **后果**: 引擎的进入门槛变高 (这是故意的); 换来迁移是"接线"而不是"改造"。
- **实现状态 (2026-09)**: `tests/conformance/suite.ts` + `backend-contract.test.ts` 已落地, 覆盖 FileBackend 与 MemoryBackend 两个实现 (21 项契约); 新增引擎只需再加一个 `describeBackend`。`Rebuildable.schemaVersion` 让"索引身份"可断言, `RebuildService` 提供 T1 (索引) 与 T2 (抽取重放) 两级重建。

## ADR-021: 多宿主 = 一个 Facade + 多个 Surface; MCP 优先

- **背景**: 宿主会换 (DSH / Claude Code / Codex / Cursor), 而 v1 的业务逻辑与 DSH 深度绑定 (工具直接 import 引擎、注入逻辑在 adapter 里)。
- **选项**: (a) 每个宿主一套实现; (b) 抽 `MemoryFacade` 唯一 API, 宿主只写"怎么触发/怎么注入"的 Surface; (c) 只做 MCP, 放弃宿主原生集成。
- **决策**: (b) + MCP 作为**最高优先级的 Surface** (覆盖面最大的事实标准), 宿主原生 hooks 用于"确定性注入"这类 MCP 给不了的保证。
- **后果**: 新增宿主 ≤200 行; 代价是 Facade 必须先稳定 (P0), 否则每个 Surface 都会催生自己的方言。

## ADR-022: 宿主适配的鲁棒性契约 (时限 / 降级 / 重入)

- **背景**: 调研发现 MemOS 的 DSH 适配器 (同一个宿主) 明确写了六条工程约束, 其中三条我们此前没有显式化: 召回**硬时限** (`min(recallTimeoutMs, 3000)`)、同轮 `agent/pre-step` **重入去重**、超时**降级到安全截断并显式声明**。记忆层是"锦上添花"的组件, 它绝不能让对话变慢或变哑。
- **选项**: (a) 依赖检索足够快; (b) 把"时限/降级/重入"写成适配层契约并测试。
- **决策**: (b)。三条硬约束: ①注入路径有硬时限 (超时 → 用规则保底通道 + 标 `degraded`); ②同轮重入只注入一次 (内容级去重之外再加一层轮次键); ③注入块声明为**不可信历史数据**并标 source (提示注入防护), 同时排除插件自身消息防递归召回。
- **后果**: 极端情况下宁可少注入也不能阻塞; `degraded` 必须能被面板/测试观察 (与 ADR-016 的降级可见同一条原则)。出处: [MemOS DSH adapter](https://github.com/MemTensor/MemOS/blob/main/apps/memos-local-plugin/adapters/deepseek-harness/README.md)。

## ADR-023: 派生索引必须带"身份", 不符即重建

- **背景**: 换 embedding 模型/分词器后混用旧索引, 会得到**静默失真**的检索 (不报错, 只是结果莫名其妙)。HippoRAG 2 用 `index_manifest.json` 绑定 embedding 身份并拒绝复用; 我们 FTS 侧已用 `tokenizer_version` 做同样的事。
- **决策**: 一切派生索引都要带身份字段: FTS → `tokenizer_version`; 向量 → `embedding_model_id` + 维度 + 归一化方式; 图 → 抽取器 id + 本体版本。身份不符**禁止复用**, 必须走对应级别的重建 (T1/T3), 并把重建报告落盘。
- **后果**: 换引擎/换模型不会"悄悄坏掉"; 代价是每次升级都要跑一次重建 (这正是 ADR-018/020 想要的能力)。

## ADR-024: 写入期演化分三档 (去重合并 / 显式取代 / 冲突标记), 规则豁免

- **背景**: "记忆会自己更新"如果做成"新记忆自动推翻旧记忆", 就会把"用户改主意了"和"用户说了句更细的话"一起吞掉; 如果什么都不做, 旧结论会一直和新结论一起被注入 (用户看到的自相矛盾)。调研也发现: mem0 OSS v3 干脆退回 ADD-only, 说明自动演化在生产上很难做对。
- **选项**: (a) 全自动 LLM 裁决 (mem0 早期 / A-MEM); (b) 只做去重不做演化; (c) 分档: 确定性的自动做, 需要判断的只标记。
- **决策**: (c)。三档且按"证据强度"升级:
  1. **duplicate (自动, 只强化)**: 归一化指纹相同, 或候选覆盖率 ≥ 0.75, 或语义余弦 ≥ 0.95 (有 Embedder 时) —— 不重复落盘, 强化老条目并合并标签/实体;
  2. **supersede (自动, 写演化链)**: 必须**四条同时成立** —— 显式更新信号 (改为/不再/废弃/替换为…)、同一种类、时间不倒退、目标是同话题 (覆盖率 ≥ 0.5); 旧条目置 `superseded` + `supersededBy` (不删除, `history()` 可查);
  3. **contradict (只标记, 不裁决)**: 数字不一致或极性相反且无更新信号 → 双向 `contradicts` 边, 两条都保持 active, 由人/后续 LLM 裁决。
- **规则豁免 (硬约束)**: 候选是 rule → 只落盘; 目标是 rule → 只标记冲突, 状态绝不由机器改 (人工闸门 ADR-003 不破)。
- **后果**: "换个说法重记"不再产生重复; "我把上限改成 50" 能自动生效且历史可查; 真正的矛盾会显式暴露而不是静默覆盖。代价是需要 LLM 的语义裁决仍未自动化 —— 那是下一步, 且必须带闸门。

## ADR-025: 向量召回默认走"同步嵌入 + 线性索引", ANN 引擎后置

- **背景**: "语义召回"如果等接上向量数据库才存在, 那这条通道永远没有测试覆盖, 也没人知道它坏了。另一方面, 预步注入 (`agent/pre-step`) 是**同步**判定点, 而主流向量库/远端嵌入 API 都是异步的 —— 直接把 async 引进检索会让注入路径变形。
- **选项**: (a) 直接接 sqlite-vec/LanceDB (引入原生依赖 + 异步索引维护); (b) 先做端口 + 同步本地实现 (线性扫描), 需要规模时再换 ANN; (c) 不做向量, 只留词/bigram。
- **决策**: (b)。三件东西: ①`SyncEmbedder` 端口 (`embedSync`) —— 只有同步嵌入器能进预步路径, 异步嵌入器必须走投影 (architecture-v2 §3.3); ②`VectorIndex` 端口 + 默认 `LinearVectorIndex` (内存线性扫描, 增量同步按内容哈希判断"要不要重嵌", 有 floor 防噪声, 有同步上限并记 `vector:scan-capped` 降级); ③默认嵌入器 `HashingEmbedder` (零依赖零成本, 中文可用, 词汇重合级语义)。
- **后果**: 语义通道默认可用、有测试 (含"字面不重合但向量相近"的召回契约)、可降级可观测; 千级条目内线性扫描够快, 万级以上必须换 ANN —— 换的时候只实现 `VectorIndex` 端口 (sqlite-vec/LanceDB/Qdrant), 检索层一行不改。身份 (`embedderId`/`dim`) 进索引, 换模型即重建 (ADR-023)。

## ADR-026: 语义检索分三层落地 (离线词典语义 / 远端真语义 / 词汇兜底), 阈值由嵌入器自述

- **背景**: 用户实测的核心缺陷是"只认精确匹配, 换个说法就找不到"。实测确认: 词汇袋哈希嵌入对同义改写几乎无用 (同义 cos≈0.17 / 无关≈0.08, 区分度太低), 而本机无法访问 HuggingFace 下载 ONNX 模型, 无法把"真语义模型"作为唯一路径。
- **选项**: (a) 只做远端嵌入 (无网/未配置就完全没有语义能力); (b) 只做本地词汇袋 (几乎无效); (c) 三层: 离线词典语义为默认, 远端真语义为可选升级, 词汇袋保留为基线/对照。
- **决策**: (c), 三者实现同一个 `Embedder` 端口, 可随时切换:
  1. **`LexicalEmbedder` (默认, 离线零依赖)**: 同义词表归一 (上线/发版→发布, 兜底→熔断) + 字级 2/3-gram (中文换词不换字) + 英文轻量词形归一。实测同义平均 cos≈0.50、无关≈0.005。
  2. **`OpenAiCompatibleEmbedder` (可选, 真语义)**: POST `{baseUrl}/embeddings` 协议 (覆盖 OpenAI/Ollama/vLLM/TEI/自建), 异步 → 配 `ProjectedVectorIndex` (后台补齐, 预步注入读投影)。配 `HX_MEMORY_EMBEDDING_BASE_URL/MODEL` 即启用。
  3. **`HashingEmbedder` (基线)**: 保留用于对照与降级。
- **附带决策 (阈值)**: 余弦下限 `floor` 由**嵌入器自己声明** —— 不同模型的相似度尺度完全不同 (词汇级 0.2-0.5, 真语义 0.7+), 全局阈值必然有一边失效。
- **效果 (本机评测, `scripts/eval-retrieval.ts`)**: 10 条记忆 × 同义改写查询, Recall@1 由 20% → **80%**, Recall@3 由 20% → **100%**; 无关查询仍为空 (无噪声)。回归护栏: `tests/conformance/paraphrase-recall.test.ts`。

## ADR-027: 预步注入的语义预热有硬时限 (宁可少召回, 不阻塞对话)

- **背景**: 远端嵌入器是异步的, 而 `agent/pre-step` 的注入判定是同步的。若每次注入都等嵌入服务, 对话就被记忆层拖住了。
- **决策**: 三层保证: ①检索器提供 `warm(deadlineMs, query)` —— 在硬时限内尽量补齐投影, **超时不报错**; ②预步处理器注入前 `await` 它 (默认 50ms, 可用 `semanticWarmupMs` 调, 0 = 完全不预热); ③未就绪时结果里带 `vector:projection-warming` 降级说明, 下一轮继续补 (不静默)。
- **附带修正**: 预热必须把**本轮查询文本**一起嵌入 (`prime`), 否则"文档就绪、查询未就绪"会让第一轮永远没有语义召回。
- **后果**: 最坏情况每轮多花 `warmupMs`; 换来数轮之内语义召回可用, 且对话延迟有上界。实测 10k 条: 预热后的检索 13.7ms/次。
