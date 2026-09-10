# Agent Note: P0-P2 加固 (性能/跨进程/强化 + 迁移/摘要/裁决 + 门禁)

Status: implemented

## Problem

一轮实测发现的问题分三档, 共同点是**本地全绿但语义错** —— 这类问题不会被"有没有抛错"的测试抓住:

**P0 (真 bug)**
1. **`alwaysOn` 在万级下 120ms**: 它走 `store.all()`, 为每条记忆做 relations + tags 两次子查询并构造完整对象; 而它位于**预步路径**, 每轮都跑。
2. **跨进程写入对向量通道不可见**: 另一个进程 (CLI / 另一个 host 实例) 写入后, 本进程的 BM25 查得到 (走 SQL)、向量查不到 (内存索引按本地写版本号判定"没变")。
3. **"命中即强化"只覆盖一条路**: 只有模型主动调 `memory_search` 才强化; **每轮都在跑的确定性注入** (prestep/binder) 一次都不调 —— 主力通道注入的记忆永远不强化、照常衰减, 与设计意图正好相反。

**P1 (可维护性)**: 4 个零引用死导出; `guidance.ts` 的提示词文本无内容断言 (刚改过却测不到); 首次检索要现建向量索引 (10k 条约 160ms 毛刺)。

**P2 (能力缺口)**: 没有导出/导入 (迁移与备份只能靠文件系统); 冲突只标记不裁决, 矛盾永久堆积; 没有"现在大概知道什么"的摘要; MCP 只有 stdio (浏览器内客户端与远程部署接不上)。

## Decision

### P0-1 廉价投影
`FileBackend.entrySummaries()`: 单条 SQL 取选择所需字段 (**必须含 confirmed_by/confirmed_at** —— 缺了会让所有规则被治理闸门静默过滤, 写这个投影时真踩过)。`FacadeOptions`/FacadeStore 增加可选 `entrySummaries`, `alwaysOn` 优先用它。
实测 10k 条: **147ms → 12.6ms (11.7x)**。

### P0-2 外部变更检测
`revision()` 合成 `writeRevision * 1_000_000 + PRAGMA data_version`。`data_version` 只在**其它连接提交后**变化 (本连接自己的提交不变), 正好用来识别外部写入。实测: 外部写入后 revision 变化, 向量通道能召回。

### P0-3 强化覆盖确定性注入
`TriggerSource.onInjected?(ids)` 回调: Binder 在两种注入路径 (通用触发通道 + 声明式绑定) 注入后回报 id; DSH 适配器接到 `facade.reinforce` (自带 60s 合并窗口, 失败静默)。

### P1
删 4 个死导出; 新增 `tests/s1/guidance.test.ts` (6 项) 把提示词的关键约束变成断言 (自动注入/回忆形状/证据非指令/查不到不要编造); 启动预热 `retriever.warmSync()` —— 放在 DSH 的**启动后台** (`setTimeout 0`) 而不是组装期同步执行, 否则只是把成本从"首次查询"转嫁成"插件加载变慢" (对一次性 CLI 尤其亏)。

### P2
- `src/app/transfer.ts`: jsonl (逐字段无损) + markdown (人可读闭环) 导出/导入; 幂等 (同 id 同内容 → unchanged); rule 缺确认记录被存储闸门拒绝并计入 errors 且不中断整批; CLI `export`/`import` 走 stdout/stdin 可管道。
- `src/evolution/adjudicator.ts` + 接入: 冲突裁决端口 (`supersede`/`keep-both`/`duplicate`) + 确定性启发式默认实现。Facade 在写入时**只对"同 kind 且硬冲突"的邻居**预裁决 (其余情形既有规则已能决定, 多跑一次纯浪费)。**双保险**: 即使注入一个"永远说 supersede"的裁决器, 目标是 rule 时 evolve 仍拒绝取代。
- `src/app/digest.ts` + Facade.digest + CLI `digest`: 只吃 active, 按 出现次数×importance 排序, 确定性; 摘要**不落盘** (派生视图, 每次现算, 避免"摘要陈旧")。
- `src/surfaces/mcp/http.ts` + CLI `mcp --http`: MCP Streamable HTTP 最小子集 (POST /mcp, GET /health, 404/405, 可选 Bearer token 且鉴权先于路由); 与 stdio 共用 `handleMessage`, 因此换传输语义不变。

## Alternatives considered

**让 `alwaysOn` 直接查 SQL 而不是走 Facade 的投影端口。** 会破坏"Surface/应用层只认端口"的分层铁律, 且把存储细节泄漏到触发层; 用可选端口 + 兜底 `all()` 既拿到性能又保住分层。

**用文件 mtime / 内容 hash 检测外部写入。** mtime 精度与时钟漂移不可靠, 全量 hash 又太贵; `PRAGMA data_version` 是 SQLite 原生为此设计的, 零成本且语义精确。

**在预步同步等待嵌入完成以保证首轮语义召回。** 会把网络/模型延迟直接加进对话延迟, 违背既有"记忆层不许拖慢对话"的约束; 维持"预步读投影 + 硬时限预热 + 未就绪记降级"。

**启动时同步预热向量索引。** 实测只是把 160ms 从"首次查询"搬到"插件加载", 对一次性 CLI 反而更亏; 改为驻留场景下的启动后台预热。

**冲突裁决放进 `decideEvolution` 内部 await。** 会让纯同步的领域逻辑变成异步, 破坏 S1 可测性; 改为调用方**预计算**裁决结果再按 targetId 查表传入。

**摘要落盘到 `digest/YYYY-MM-DD.md`。** 会引入"摘要与库不同步"的新失效模式, 而摘要本来就可以随时重算; 保持派生视图。

## Consequences

预步路径不再为 hydration 白付成本 (11.7x); 多实例/CLI 并存的召回不再漏; "用进废退"覆盖主力通道; 迁移/备份、冲突裁决、摘要、远程 MCP 从"没有"变成"有且被测"。代价: ①`entrySummaries` 的字段集与 `selectAlwaysOn` 的输入耦合, 改选择逻辑要同步改投影 (已由测试钉住规则仍被选中); ②裁决默认启发式是保守的 (说不清就 keep-both), 真正的判断仍需要人; ③HTTP 传输只做了最小子集 (SSE/session 头未实现), 复杂客户端可能需要补齐。

## Testing

新增 46 项 (总 575):
- `tests/s2/p0-hardening.test.ts` (5): 投影语义等价 + `alwaysOn` 不触碰 `all()` + 跨进程 revision 变化且向量可召回 + `onInjected` 回报 + 端到端 reinforcement 增长。
- `tests/s2/adjudication-wiring.test.ts` (6): 取代/keep-both/规则双保险/裁决器抛错退回安全默认/autoEvolve=false 不裁决/无冲突不裁决。
- `tests/s2/transfer.test.ts` (6): 跨引擎无损往返 + 幂等 + 治理不绕过 + 坏行容错 + 无尾换行 + markdown 闭环。
- `tests/s2/mcp-http.test.ts` (12) + `tests/s2/cli-mcp-http.test.ts` (1): 协议面 + CLI 接线 (真子进程 + 真 HTTP + 优雅退出)。
- `tests/s1/adjudicator-digest.test.ts` (12) + `tests/s1/guidance.test.ts` (6): 纯逻辑与提示词内容契约。
