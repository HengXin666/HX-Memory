# 市面开源 Agent 记忆系统调研 (对标与取舍)

> 目的: 回答两个问题 —— ①别人已经解决了哪些问题 (值得抄); ②我们哪些做法是别人没有的 (值得留)。
> 边界 (不写什么): 不复述各家安装文档; 不做跑分对比 (各家 benchmark 口径不一致, 只在有公开论文出处时引用); 不写实现细节 (在 [architecture-v2.md](architecture-v2.md))。
> 与代码的关系: 本文的"值得抄"逐条映射到 `src/` 的实现或 `docs/adr.md` 的决策; 标 `[已实现]` 的是本仓库已有测试的活动代码, `[计划]` 的在 architecture-v2.md 的路线图里。
> 证据口径: 数据截至 **2026-09**, 尽量核到一手仓库/文档; 有版本时效性的结论都在行内标注。未能核实的写"待核实"。

## 0. 一句话结论

市面方案在**抽取与更新** (mem0 的近邻裁决、Graphiti 的时序失效) 与**多级记忆结构** (Letta 的 MemFS、Cognee 的 ECL、Zep 的三层图) 上比我们成熟; 我们在**跨项目推广 + 人工闸门 + 真相在文件 (可全量重建) + 声明式确定性注入**上是稀缺组合。

两个反直觉的发现决定了我们的路线:

1. **开源头部正在收缩"记忆演化"**: mem0 OSS v3 (2026-04 起) 改为 **ADD-only** 并把图记忆整体移出 OSS; Zep 社区版已废弃转向 Cloud。也就是说"可自建的冲突消解 + 图谱"这一层在开源侧**正在变少**, 我们 ADR-005 的 supersedes 链不是落伍, 而是踩在少数仍开放的位置上 —— 该补齐它, 而不是外包出去。
2. **最接近我们的 Letta 已经转向"文件即记忆"**: Letta Code 的 MemFS 用 **git 仓库 + Markdown/YAML frontmatter** 存记忆, 默认**不建向量索引**。这与我们的 truth-in-files 是同一个判断。

因此策略是: **端口切面 + 抄机制 + 换引擎**, 不整包引入运行时。

## 1. 总表

| 项目 | 存储 | 检索 | 演化机制 | 关联/图 | 宿主接入 | 许可 / 活跃度 | 借鉴 | 不复刻 |
| ---- | ---- | ---- | -------- | ------- | -------- | ------------- | ---- | ------ |
| **mem0 (OSS v3)** | 28+ 向量库 + SQLite history | 语义 + BM25(词形还原) + 实体加分, 加权融合 | **2026-04 起 ADD-only 单趟抽取, 取消 UPDATE/DELETE**; 仅 md5 精确去重 + `expiration_date` 过期隐藏; ~~图记忆~~ 已移出 OSS | OSS 无图 (Platform 才有) | Python/TS SDK、REST、官方 DSH 插件 | Apache-2.0, 65k★ | 打分融合 (sigmoid 归一 + 加法融合 + 语义阈值前置); 抽取管线 | v3 的 ADD-only (我们不放弃演化, 但也不自动删) |
| **Graphiti (Zep)** | Neo4j / FalkorDB (含嵌入式 Lite); **Kuzu 已弃用** | BM25 + cosine + BFS 三路 → RRF/MMR/cross-encoder/node_distance 重排 | **边级双时态** `valid_at/invalid_at/expired_at`; 矛盾边**失效而非删除** | 实体节点 + 事实边 + Episode 溯源; 本体可 Pydantic 定义 | Python 库、官方 MCP server | Apache-2.0, 31k★; Zep 社区版已废弃转 Cloud | Episode 真值; 四元组双时态; 三阶段检索; 失效而非删除 | 常驻图库 |
| **Letta Code** (原 MemGPT) | **git 仓库 + Markdown/YAML frontmatter (MemFS)**; 默认无向量索引 | 文件搜索/读为主; 可选关键词+语义混合 | **dreaming (sleep-time compute)** 后台子代理整合; `/doctor` 审计重复与 token | 文件树当"路标"; 无图 | npm CLI/桌面/Slack 等; MCP 客户端; hooks; TS SDK | Apache-2.0; 旧仓库 V1 已归档 | 分层记忆 + 后台整理; `system/` 常驻块 | 让 agent 自己在上下文里管记忆 |
| **Cognee** | 向量(LanceDB/pgvector/Turso) + 图(Kuzu/Neo4j/Neptune) + 关系层 | 自动路由的多策略 (图/向量/代码) | `remember/recall/improve/forget`; 会话记忆蒸馏进永久图; 支持反馈 | 实体-关系图 + 本体 | MCP、Claude Code/Codex 插件、REST、TS SDK | Apache-2.0, 31k★ | 管线可重跑 (与 T1/T3 重建同构); `improve` 作为一等动词 | Python 常驻 |
| **MemOS 2.0** | 本地版 **SQLite + FTS5 + 向量**; 服务版 Neo4j + Qdrant | 混合 (FTS5 + 向量) + 智能去重 | L1 traces / L2 policies / L3 world model 分层演化 + 技能结晶 | 记忆立方 (MemCube) 可组合 | **官方 DSH 插件** (`agent/pre-step` 有界召回 + 六工具 + Viewer) | Apache-2.0, 11k★ | **宿主适配的鲁棒性契约** (见 §2.7) | 分层演化模型 (对我们的 rule 人工闸门是冲突的) |
| **A-MEM** | ChromaDB | 向量 + BM25 混合 | **Zettelkasten 演化**: 新记忆触发邻居 `strengthen`/`update_neighbor` | 双向链接 + 标签/上下文 | Python 库 | MIT, 1.2k★, **停更 ~9 个月** | 写入即演化的**动作协议** (见 §2.5) | 研究原型的成熟度 |
| **LangMem / LangGraph** | 任意 (`BaseStore`) | `store.search` 向量检索 | 后台 memory manager 抽取+合并; 程序记忆用 metaprompt 优化 | 无图 (namespace) | LangGraph 工具 | MIT; **PyPI 最后发版 2025-10, 事实停更** | 语义/情景/程序三分法 | 把编排责任全丢给开发者 |
| **Basic Memory** | Markdown 真相 + SQLite 索引 (可选 Postgres+Milvus) | 关键词 + 可选语义 + cross-encoder 重排 | 双向同步 + watcher | `[[wikilink]]` + observation 构成知识图 | **MCP 原生** | **AGPL-3.0**(注意传染性), 3.9k★ | truth-in-files + MCP 接入面 | 人写为主, 无自动演化 |
| **HippoRAG 2** | OpenIE 图 + 向量 (含同义边) | **Personalized PageRank** + 查询→三元组链接 + rerank | 增量索引; **`index_manifest.json` 绑定 embedding 身份, 不符拒绝复用** | 开放 KG + 同义边 | Python 库 | MIT, 4k★, 活跃 (ICML'25) | 索引身份清单 (我们 T3 重建的判据) | 离线索引成本 |
| **txtai** | 向量 (稀疏+稠密) + 图网络 | SQL + 向量 + 图分析 | 无专门演化 | 图网络 | MCP API, 多语言绑定 | Apache-2.0, 13k★ | 多模态检索面 | 不是记忆层 |
| **Generative Agents** | 本地 | `score = 相关性 + 重要性 + 新近度` | **reflection**: 周期性抽象出高层洞察 | 弱 | 研究代码 | 论文 | 打分三要素; 反思 | 全量注入 prompt |
| **MemoryBank** | 本地 | 向量 | **Ebbinghaus 遗忘曲线** + 命中强化 | 弱 | 研究代码 | AAAI 2024 | 衰减/强化思路 | 原论文以定性描述为主, 慎引具体公式 |
| **MCP memory server** | 本地 JSON 知识图 | 名称/类型/observation 子串检索 | 仅增删改 | 实体-关系图 | **MCP 参考实现** | MIT-ish | 工具面设计 (见 §2.6) | 能力太薄 |
| **MemoRAG / Memobase** | — | — | — | — | — | Apache-2.0; **停更 8–12 个月** | — | 不建议选型 |

> 许可地雷 (选型必须排除或只允许进程外调用): **FalkorDB = SSPL v1** (非 OSI 开源), **Basic Memory = AGPL-3.0** (传染性), **Neo4j Community = GPL-3.0**。
> **Kuzu 上游已归档 (2025-10)**, Graphiti 已弃用它 —— 任何以 Kuzu 为前提的设计都是死路。
> 我们自身是 Apache-2.0 + 100% 自维护, 这是资产: 引擎选型只允许"可进程外调用 或 许可宽松 (MIT/Apache/公共领域)"。

## 2. 真正值得抄的机制 (逐条, 带出处)

### 2.1 打分融合: sigmoid 归一 + 加法融合 + 语义阈值前置 (mem0)

> 出处: [mem0 `utils/scoring.py`](https://github.com/mem0ai/mem0/blob/main/mem0/utils/scoring.py)。

- BM25 分数按**查询长度自适应**做 sigmoid 归一: `≤3` 词用 `(midpoint 5.0, steepness 0.7)`、`≤6` 用 `(7.0, 0.6)`、`≤9` 用 `(9.0, 0.5)`、其余 `(12.0, 0.5)`, 压到 [0,1] 再融合; 直接用原始 BM25 与余弦相加是量纲错误的。
- 融合是**加法**: `(semantic + bm25 + entity_boost) / max_possible`, 实体权重 0.5; 且**先用阈值卡语义分再融合**, 避免 BM25 把低质候选"救回来"。
- 我们的落地: `[已实现]` RRF 融合 (免疫量纲); `[计划]` 语义通道接入时照抄"阈值前置", 不要事后相加。

### 2.2 写入期近邻裁决 (mem0 早期版本)

> 出处: [mem0 论文 (arXiv 2504.19413)](https://arxiv.org/abs/2504.19413); 机制经参考笔记交叉核对。注意 **OSS v3 已改为 ADD-only**, 论文描述的是早期流水线。

机制: 抽候选 → 检索 top-s 相似记忆 → LLM 用工具调用选 ADD/UPDATE/DELETE/NOOP。
我们的落地: `[已实现]` 确定性版本 (`src/evolution/associate.ts`: 归一化指纹 + 候选覆盖率 + 自动建边); `[计划]` LLM 裁决。**关键差异: 我们不做 DELETE** —— 矛盾只产生 `supersedes`/`contradicts` 关系与状态变更 (ADR-019)。

### 2.3 三层结构 + 四元组双时态 + 三阶段检索 (Zep/Graphiti)

> 出处: [Zep 论文 (arXiv 2501.13956)](https://arxiv.org/abs/2501.13956); [Graphiti `edges.py`](https://github.com/getzep/graphiti/blob/main/graphiti_core/edges.py) 与 [`edge_operations.py`](https://github.com/getzep/graphiti/blob/main/graphiti_core/utils/maintenance/edge_operations.py)。

- 三层: episode (原始不丢) → 语义实体/事实 (带有效期) → community 摘要。
- 双时态**四元组**: `valid_at/invalid_at` (事实世界) + `created_at/expired_at` (系统世界) + `reference_time` (事件真实发生时间)。我们目前只有两个 (validAt/assertedAt), v2 的 `expiresAt` 补上了系统侧的一半。
- 矛盾消解: 新事实与旧边冲突 → 旧边 `invalid_at = 新边.valid_at`, `expired_at = now` —— **不删除**, 支持时间旅行查询。
- 检索: search (cosine + BM25 + BFS) → rerank (RRF/MMR/cross-encoder/node_distance) → construct context (带有效期区间)。
- 我们的落地: `[已实现]` 混合检索 + RRF + MMR + 时间衰减 + `asOf` 切片; `[已实现]` 演化链读侧; `[计划]` episode 真值层 (ADR-018) 与写入侧失效链。

### 2.4 有预算的分层记忆与后台整理 (Letta)

> 出处: [Letta MemFS 概念文档](https://docs.letta.com/concepts/memfs)。

- `system/` 目录每轮进系统提示 (常驻块), 其余靠"文件树当路标"按需读 —— 与我们的"声明式绑定 + 按需召回"同构。
- **dreaming (sleep-time compute)**: 后台子代理整合记忆; git worktree 让后台改写不阻塞主代理; `/doctor` 审计重复与 token 占用。
- 我们的落地: `[已实现]` 声明式绑定 + 确定性预步注入 (ADR-008) + token 预算; `[计划]` 后台整合调度器 (S3), 并且**规则类改动永远走人工闸门** (ADR-003)。

### 2.5 写入即演化: 动作协议 (A-MEM)

> 出处: [A-MEM `memory_system.py`](https://github.com/agiresearch/A-mem/blob/main/agentic_memory/memory_system.py)。

机制: 新记忆写入时让 LLM 返回结构化动作 `{should_evolve, actions:[strengthen|update_neighbor], suggested_connections, tags_to_update, new_context_neighborhood, new_tags_neighborhood}`, 用 `evo_threshold` 控制批频率 —— **注意它允许新记忆反向更新邻居**, 这是"关联性"落地最具体的一份协议。
我们的落地: `[已实现]` 写入期建边 (relates, 权重=相似度); `[计划]` 链接触发的反向更新 (S2), 但**动作白名单化**: 只允许加边/合并标签实体/建议 supersede, 不允许直接改写他人正文。

### 2.6 MCP 工具面与资源 (官方 memory server)

> 出处: [modelcontextprotocol/servers/src/memory](https://github.com/modelcontextprotocol/servers/tree/main/src/memory)。

工具: `create_entities/create_relations/add_observations/delete_*/read_graph/search_nodes/open_nodes`, 资源 `memory://knowledge-graph` + `notifications/resources/updated`。
我们的落地: `[计划]` P4 的 MCP Surface 以 Facade 为唯一实现 (`memory_search`/`memory_save`/`memory_link`/`memory_history`), 并补 `memory://` 资源用于面板/CLI 观察。

### 2.7 宿主适配的鲁棒性契约 (MemOS 的 DSH 适配器)

> 出处: [MemOS `apps/memos-local-plugin/adapters/deepseek-harness`](https://github.com/MemTensor/MemOS/blob/main/apps/memos-local-plugin/adapters/deepseek-harness/README.md)。

**这是本轮调研里对我们最直接有用的一条** (同一个宿主, 同样的坑):

1. 召回**硬时限** `min(recallTimeoutMs, 3000)` —— 记忆层不许拖慢对话;
2. 同轮 `agent/pre-step` **重入去重** (我们已有内容级去重, 但"同轮重入"这一层要显式化);
3. 超时**降级到 safeCutoff** 并把降级说出来, 而不是静默给空;
4. 注入包 `<memos_context>` 并标 source;
5. **排除插件自身消息**, 防递归召回 (我们有 `rootAgentsOnly` + source 过滤, 但"插件自身消息"要按 surface 再确认);
6. 注入内容**声明为不可信历史数据** (提示注入防护)。

我们的落地: `[已实现]` 2/5/6 的等价物 (内容去重、rootAgentsOnly、上下文以 `source.kind=plugin` 注入); `[计划]` 硬时限 + 显式降级标记 + 重入去重。

### 2.8 索引身份清单 (HippoRAG 2)

> 出处: [HippoRAG](https://github.com/OSU-NLP-Group/HippoRAG) 的 `index_manifest.json`。

机制: 索引里绑定 embedding 模型/端点/归一化身份; 配置不匹配就**拒绝复用并要求重建**, 而不是混用两种向量的索引。
我们的落地: `[已实现]` FTS 侧的 `tokenizer_version` (版本不符 → 清表重建); `[计划]` 向量侧同构的 `embedding_model_id`。

## 3. 我们的差距矩阵 (v1 → v2)

| 能力 | 市面标杆 | v1 | v2 |
| ---- | -------- | -- | -- |
| 精确去重 | 全都有 | 有 | 有 |
| **近义去重** | mem0 (早期 LLM 决策) / 现在多数退回精确 | 无 | `[已实现]` 确定性 (指纹 + 覆盖率); `[计划]` 语义通道 |
| **冲突消解/版本化** | Graphiti (失效而非删除) | 只有链语义, 无写入者 | `[计划]` S2 裁决 (不删除, 只 supersede) |
| **双时态** | Graphiti 四元组 | 两字段, 检索未用 | `[已实现]` `asOf` 切片 + `expiresAt` |
| **多级记忆** | Zep community / Letta MemFS / Cognee 管线 | digest 目录无自动刷新 | `[计划]` S3 整合 |
| **混合检索** | Zep 三阶段 / MemOS FTS5+向量 | 关键词 includes | `[已实现]` BM25(中文可用)+图+RRF+MMR; `[计划]` 向量 |
| **中文检索** | 多数方案依赖向量或外部分词 | 无 | `[已实现]` 词 + bigram 双流 (实测) |
| **token 预算** | Zep construct context | 只有条数 | `[已实现]` 三段预算 + 保底配额 |
| **遗忘/衰减** | MemoryBank | 无 | `[已实现]` 打分侧; `[计划]` 状态侧 |
| **原始轨迹留存** | Zep episode | 无 (context 不落盘) | `[计划]` Episode 真值层 |
| **多宿主** | MCP 生态 / MemOS 已有 DSH 插件 | DSH + Codex 两套实现 | `[已实现]` Facade; `[计划]` MCP/Claude |
| **引擎可替换 + 全量重建** | Graphiti 多图库 / HippoRAG manifest | 单实现 + 方法级 rebuild | `[已实现]` 端口 + FTS 重建 + 版本校验; `[计划]` conformance |
| **跨项目推广 + 人工闸门** | **无对标** | 有 | 有 (差异点) |
| **真相在文件可审计** | Letta MemFS / Basic Memory | 有 | 有 (差异点) |

## 4. 引擎候选排序 (适配成本 / 风险 / 许可)

| 排序 | 候选 | 适配成本 | 许可 | 判断 |
| ---- | ---- | -------- | ---- | ---- |
| **1** | **SQLite FTS5** (node:sqlite 内置) | 极低 | 公共领域 | **已完成**。中文需分词 (见 ADR-017) |
| **2** | **sqlite-vec** | 低 (`loadExtension`, 需 `allowExtension:true`) | MIT OR Apache-2.0 | 单文件同仓, 可降级。**风险: 仍是 0.1.x alpha, 只作可选派生索引, 不做唯一检索路径** |
| 3 | LanceDB | 中 (Node 绑定成熟, 列式+多模态) | Apache-2.0 | 本地大规模/多模态时上; 原生依赖要隔离在适配层 |
| 4 | tantivy | 中 | MIT | 纯 BM25 需求下 FTS5 已够, 收益有限 |
| 5 | Qdrant | 中高 (外部服务) | Apache-2.0 | 多用户/服务化形态才划算 |
| 6 | pgvector | 中高 | PostgreSQL License | 已有 Postgres 才划算 |
| 7 | DuckDB VSS | 中 | MIT | 分析型强、向量弱, 不做主索引 |
| 8 | Graphiti | 高 (Python + 图库 + LLM 写成本) | Apache-2.0 | **只抄双时态边模型与失效协议, 不整包引入** |
| ❌ | Neo4j | 高 | **GPL-3.0** | 许可+运维都不划算 |
| ❌ | Kuzu | — | MIT | **上游已归档 (2025-10)**, Graphiti 亦弃用 |
| ❌ | FalkorDB | 高 | **SSPL v1** | 非 OSI 开源, 嵌入/分发需法务确认 |

## 5. 结论: 抄什么 / 不抄什么

**抄 (机制)**: 打分融合的 sigmoid 归一与阈值前置 (mem0) · 写入期近邻裁决 (mem0 早期) · episode 真值 + 四元组双时态 + 失效而非删除 (Graphiti) · 三阶段检索与 RRF/MMR (Graphiti) · 分层记忆与后台整理 (Letta) · 打分三要素与反思 (Generative Agents) · 遗忘曲线 (MemoryBank) · 写入即演化的动作协议 (A-MEM) · 索引身份清单 (HippoRAG 2) · 宿主适配鲁棒性契约 (MemOS) · MCP 工具面 (官方 memory server)。

**不抄 (架构)**: 不整包引入运行时 · 不把真相交给引擎 · 不自动改规则 (人工闸门是产品承诺) · 不物理删除记忆 · 不把记忆塞进上下文预算里让模型自己管 · **不接受 SSPL/AGPL/GPL 依赖进入分发物**。

**我们不可替代的部分**: 跨项目推广 (具体经验 → 全局规则) + 人工闸门 + 双向可追溯 (规则 ↔ 实例) + 真相在文件 (git 可 diff / 可全量重建) + 声明式绑定确定性注入。开源头部正在收缩这几条里的一部分 (mem0 ADD-only、Zep CE 废弃), 所以它们更值得自持。

## 相关

- 目标架构与迁移协议: [architecture-v2.md](architecture-v2.md)
- 决策记录: [adr.md](adr.md) (ADR-015 起为 v2)
- 现状分层: [architecture.md](architecture.md)
