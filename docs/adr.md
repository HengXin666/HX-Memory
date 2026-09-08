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
