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
