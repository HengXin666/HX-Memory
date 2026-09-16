# Agent Note: 捕获耗时账本 (把"沉淀慢在哪一段"落成可查的证据)

Status: implemented

## Problem

捕获链路一直是**异步**的: 接线处写的是 `void runtime.capture(...)`, 而 DSH 的 `session/event` 派发
(`dsh-session` 的 `invokeContainedSessionObservers`) 只是调用监听器然后把返回的 promise 挂一个
`.catch` 丢掉, 从不 await。因此"捕获阻塞对话"这个说法在**调用序**上是错的 —— 但它掩盖了一个真实问题:

**异步不等于免费。** 捕获与对话跑在同一个进程、同一个 event loop 上, 而它自己会:

- 调一次真实模型做结构化 (`llm-structurer.ts`, 超时 10s, 用的是宿主的 `agentDefaultModel` —— 与主对话**同一个上游**);
- 读全库做共现比较来建边 (`pipeline.withStructuralLinks` → `store.all()`);
- 用**同步**的 `node:sqlite` 写索引与真相文件。

于是"某一轮比平时慢"在证据上完全无法回答。当时唯一的计时证据是 `llm-agent.ts` 里的一行
`ctx.logger`, 它是宿主日志: 与"具体哪一轮"对不上号, 重启后也拿不到, 而且它只覆盖 LLM 那一段。

这正是注入调度账本当年解决的同一类问题 (判定没有落盘 → 只能读源码猜), 只是换到了**耗时**轴。

## Decision

新增 `adapters/dsh/capture-log.ts`: 与 `schedule/` 同构的**追加式 JSONL 账本**
(`<root>/capture/YYYY-MM-DD.jsonl`), 每一轮完成的问答落一条, 记录:

- 结果 (`stored` / `skipped` / `error`)、跳过原因 (闭集: `disabled` / `subagent` / `no-turn` / `no-signal` / `no-conclusion`)、
  落盘条数、问题与回答的字符数 (耗时的主要解释变量);
- **四段各自的毫秒数**: `episodeMs` (原文追加) / `enrichMs` (结构化) / `linkMs` (建边) / `storeMs` (落盘),
  以及 `totalMs`。

客户端 (面板新增「沉淀耗时」tab) 拿到的是**分位数 + 分段均值 + 最近明细**, 而不只是平均值:
慢捕获是长尾现象, 平均值会被大量 1ms 的正常轮次稀释到看不出问题。

三处结构上的连带决定 (都不是随手选的):

1. **测量点在 pipeline, 记录点在 adapter**。分段耗时只有 pipeline 知道 (它才知道 enrich/link/store
   各自花了多久); 而"这条属于哪个会话、第几轮、哪个项目"只有 runtime 知道。因此 pipeline 只
   **测量并回报** (`CaptureOptions.onTiming`), 账本形状由 `capture-ledger.ts` 单独产出 ——
   两处各拼一遍 record 就会分叉, 而分叉的表现是"有些轮次的耗时字段恒为 0", 静默且难查。

2. **落盘语义收敛成一份 (`jsonl-ledger.ts`)**。`schedule-log` 已经在做"按天分文件 / 只追加 /
   单日行数上限 / 保留期 / best-effort"这一整套; 抄第二遍不只是会被 `verify-structure` 的 jscpd
   判成重复, 更要紧的是它会**分叉** —— 保留期或失败语义只改了一处, 另一处静默保持旧行为,
   而账本的失效恰恰是静默的。两个账本现在各自只剩"记录形状 + 聚合视图"。

3. **runtime 拆成三份**。加完测量点后它到了 469 行 (上限 400)。按职责切开:
   项目键解析 → `project-key.ts`; 轮次配对与账本形状 → `capture-ledger.ts`;
   runtime 只剩事件状态机 + 缓冲与冲刷。拆完 304 行, 且"一轮何时算完成"这条规则第一次可以单独测。

## Alternatives considered

**只在 `llm-agent.ts` 的日志里补更多字段。** 那是宿主日志, 按时间戳混在所有其它日志里,
无法按会话/轮次取; 而且它只覆盖 LLM 一段 —— 而 `episodeMs` 与 `storeMs` 恰恰是"异步捕获也会
占住 event loop"的那部分。排查类问题发生在重启之后, 日志卷不完这些。

**用内存环形缓冲 (像 `InvocationLog`)。** 更便宜, 面板也够用 —— 但"昨天那几轮为什么慢"是跨重启
问题, 内存缓冲在那一问上等于零; 并且它与"真相在文件"这条仓库不变量冲突 (同 `schedule-log` 的取舍)。

**让 pipeline 直接持有 CaptureLog。** 最省事, 但会把内核层 (`src/capture/`) 反向依赖到 DSH adapter,
违反"内核不依赖 harness"这条分层约束。现在的形状是 pipeline 只回报数据, 由 adapter 决定记到哪。

**把耗时记成 episodes 的一部分。** episode 是**重放输入**, 数量级与生命周期都由"重建"决定;
耗时是观测数据, 两者混在一起会让 T2 重建多背一份无关载荷, 也会让保留期互相绑架。

**不做账本, 先凭直觉优化 (换模型 / 调 interval)。** 那样无法验证任何一条优化有没有生效 ——
这正是本仓库反复拒绝的形态: 先有可观察的证据, 再谈优化。

## Consequences

- 换来的: 捕获成本第一次**分段可归因**。面板能回答"这个会话的 p50/p95/max 是多少、慢在哪一段、
  有几轮压根没沉淀以及为什么"; `tail -f <root>/capture/$(date +%F).jsonl` 是同一份数据的 CLI 形态。
- 付出的: 每轮一次小文件 append 与四段计时 (相对它测的那些成本可忽略);
  以及一份新的需要保留期管理的真相文件。
- **`totalMs` 刻意不自称端到端延迟**: 宿主没有"这一轮对话总共花了多久"的稳定接口, 因此这个数
  记的是"捕获在 `turn/end` 之后又占用了多久"。把它读成对话延迟是误读, 这一点在代码注释、
  面板提示与 `docs/capture-and-distillation.md` 里都写明了。
- 它有自己的开关 (`captureLog`) 与保留期 (`captureRetentionDays`, 默认 7 天), **不挂在**
  `autoCapture` 或 `scheduleLog` 上: 三条是不同的事情, 关掉其中一个不应连带失去另一个的观测。
- 未覆盖: 宿主在 `turn/end` **之前**的时间 (模型思考、工具执行) 不在账本里 —— 它不是捕获的成本。
  同样未覆盖: 结构化那次 LLM 调用是否命中上游限流 (账本只看到它花了多久)。

## Testing

- `tests/s2/capture-log.test.ts` (14 例): 按天分文件与追加语义 / 坏行跳过 / 单日行数上限 /
  保留期与 0 = 永久 / 写失败 best-effort (断言不抛且带标志) / 写出即原样读回;
  **分位数而非平均值** (p50/p95/max + 分阶段均值 + 最慢一条能被指出来);
  跳过的轮次不进耗时统计但要能被计数。
  运行时接线部分覆盖全部五种跳过原因 (落盘 / 读不出结论 / 没形成问答 / 捕获关着 / subagent)、
  落盘抛错记 `error` 行, 以及"不注入账本时行为完全不变且磁盘上不出现 `capture/` 目录"。
- `tests/s2/settings-adoption.test.ts`: 端到端 —— 真的跑 `apply()`, 走一轮完整问答, 断言
  `<root>/capture/*.jsonl` 出现完整记录 (含宿主给的轮次号与字符数), 且把 `captureLog` 关掉后
  **不再写新行、但捕获照常工作** (设置当轮生效)。
- `tests/s2/remote-methods.test.ts`: 新 RPC `captureLog` 纳入"客户端只许调用声明过的方法"这条契约。
- `scripts/smoke-dsh-http.mjs`: 真机断言 `hxMemory/captureLog` 的信封与形状
  (空数组与全 0 统计是正常结果, `available` 才是契约)。
- 全量 `vitest run` 785 用例全绿; `verify-structure` (96 文件, 含新增三文件) / `verify-docs` /
  `oxlint` / 两端 `tsc` 全部通过。
