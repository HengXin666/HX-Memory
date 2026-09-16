# Agent Note: 注入调度账本 (把触发层的"为什么"落成可查的证据)

Status: implemented

## Problem

`trigger/policy.ts` 的头注释把设计目标写得很清楚: "每次决策都给出 reason/confidence/budget,
落进触发日志 —— '为什么没注入' 必须和 '注入了什么' 一样可查"。但**没有任何东西落盘**:

- `TriggerDecision` 只活在 `Binder` 的私有字段里, `lastTriggerDecision()` 在被引入时就
  标注为"供测试与可观测读取", 而全仓的调用方只有测试 —— 面板与日志都拿不到;
- 预步的"没注入"有四种成因 (first 模式已给过 / 差量后没有新条目 / 整块文本判重 / 没有通道可走),
  它们此前在外部**完全不可区分**。用户看到"这轮没注入记忆"时唯一能做的推断是读源码;
- 结果是这一层的行为只能靠"造一个复现 case 再跑单元测试"来观察。真实的注入行为发生在用户的
  会话里, 而那里没有任何证据留存。

## Decision

新增 `adapters/dsh/schedule-log.ts`: 一个**追加式 JSONL 账本** (`<root>/schedule/YYYY-MM-DD.jsonl`),
每一步判定落一条, 由 `pre-step` 在真实判定点回调写入。

- 记录形状 (`ScheduleRecord`): at / session / project / step / channel (binding|trigger|none) /
  mode / outcome (injected|skipped|nothing-new|empty) / intent / confidence / topicDrift / reason /
  selected / ids / tokens。
- **落盘位置是真相文件区** (与 `episodes/` 平级), 不是索引: 只追加、永不改写, 坏了只丢一行。
  因此它没有重建路径, 只有保留期 (默认 14 天, 单日 2000 行上限)。
- 写入是 **best-effort**: `append()` 永不抛错, 落在记账本之外的失败只置一个 `hasWriteFailed()` 标志。
  记忆层不许拖垮对话, 这条与捕获路径同一条价值观。
- 出口是 gateway 的 `scheduleLog` RPC (按会话聚合 + 最近原始记录 + 磁盘体量), 面板新增
  「注入调度」tab。没有挂载账本时明确返回 `available:false`, 由面板显示"本宿主没有账本",
  而不是画一个说不清是"没有数据"还是"没接上"的空白。
- `Binder` 补三个 debug 面 (`lastInjectionChannel`/`lastSelectedIds`/`lastInjectedTokens`),
  并在"绑定通道一条都没发出去"时也如实记录通道与选中集 —— 否则调用方只能拿到上一次的状态,
  会把"被差量挡掉"误报成"库里没有"。

组装根 `index.ts` 因此逼近 400 行上限, 顺手把"会话开始注入"整段策略抽到 `session-start.ts`
(组装根只接线, 不装策略)。

## Alternatives considered

**做成内存环形缓冲 (像 `InvocationLog`)。** 它更便宜, 也足够面板用 —— 但"为什么昨天那轮没注入"
是排查类问题, 恰恰发生在进程重启之后, 内存缓冲在那一问上等于零。附加代价是它与"真相在文件"
这条仓库不变量相冲突。

**把决策塞进已有的 episode 日志。** episode 是**重放输入**, 数量级与生命周期都由"重建"决定;
调度记录是观测数据, 两者混在一起会让 T2 重建多背一份无关载荷, 也会让保留期互相绑架。

**由 agent 用工具/自述来报告"我为什么没拿到记忆"。** 这正是 `r00155cdb954e41c7` 那条记忆
否掉的形态: 触发层存在的唯一理由就是"模型无法可靠地知道自己不知道什么"。要它自述注入行为
是把同一份判定重新交给概率。判定已经是确定性的, 账本只是把确定性的结果写下来。

**在 `session/event` 回调里事后读 Binder。** pre-step 是 waterfall, 事件回调在它之后且没有 step;
事后读私有状态会把"本轮判定"和"最后一次判定"混成同一个读数 (真实缺陷类别)。

## Consequences

- 换来的: 注入行为第一次**可事后审计**。面板能回答"这个会话注入了几次、哪些被跳过了、为什么、
  各模式占比、花掉多少 token"; `tail -f <root>/schedule/$(date +%F).jsonl` 是同一份数据的 CLI 形态。
- 付出的: 每步一次文件 append (小追加, 与 MMR/检索成本相比可忽略), 以及一份新的需要保留期管理的
  真相文件。因此它有自己的开关 (`scheduleLog`) 与保留期设置, 不挂在 `autoCapture` 上 ——
  两者是不同的事情, 关掉捕获不应连带失去调度观测。
- `tokens` 是**估算** (与注入预算同一把尺 `kernel/ranking.estimateTokens`), 名字就写着"≈"。
  宿主的实际上下文消耗没有稳定接口, 因此这个数只用来横向比较"哪一轮更贵", 不假装是计量值。
- 未覆盖: `session-start` 那次注入不经过 pre-step, 因此不在账本里 (它的结果会体现在随后的
  差量判定上)。把会话开始也纳入账本是下一步, 需要把 pre-step 的判定点同样接到那条路上。

## Testing

- `tests/s2/schedule-log.test.ts` (10 例): 按天分文件与追加语义 / 坏行跳过 / 单日行数上限 /
  保留期与 0 = 永久 / 按会话聚合 (计数、模式分布、token 求和、last* 取最新) / pre-step 三种落账路径
  (注入 / 没有通道 / first 模式跳过) / 写失败 best-effort (断言不抛且带标志)。
  其中"写失败"一例刻意不用 `/proc` 这类特殊路径 —— 它在某些内核上会让 `mkdir` 卡住,
  把一条单元断言变成挂起 (实测踩到), 改用"root 指向一个文件"这种确定性不可写。
- `tests/s3/dsh-adapter.test.ts`: 端到端接线 (假 harness 走 pre-step → 账本真的落在磁盘上),
  以及 gateway 缺依赖时 `available:false`。
- `tests/s2/settings-adoption.test.ts`: 最外层的一条 —— 真的跑 `apply()`, 断言
  `<root>/schedule/*.jsonl` 出现完整记录, 且把 `scheduleLog` 关掉后**不再写新行** (设置当轮生效)。
- `tests/s2/remote-methods.test.ts`: 客户端页面列举改为目录扫描 (而不是硬编码两个文件名),
  新页面自动纳入"只许调用声明过的方法"这条契约 —— 硬编码清单恰好会漏掉"新加了一个页面"。
- `scripts/smoke-dsh-http.mjs`: 真机断言 `hxMemory/scheduleLog` 的信封与形状
  (空数组是正常结果, `available` 才是契约)。
- 一条真实的踩坑留在测试里: "不可写路径"不能用 `/proc/...` 构造 —— 它在当前内核上会让
  `mkdir` 卡住, 把单元断言变成挂起 (实测), 改用"root 指向一个普通文件"这种确定性不可写。
- 全量 `vitest run` 686 → 699 用例全绿; `verify-structure` (82 文件) / `verify-docs` /
  `verify-agent-note-format` / `verify-agent-note-classification` / `verify-agent-note-coverage` /
  `oxlint` / 两端 `tsc` / client bundle 全部通过。
- 未修复的既有问题 (与本改动无关, 已在改动前确认): `verify-bench-snapshot` 报
  `B 哈希近似语义 R@1: 0.6411 → 0.635`。在**干净的 HEAD** 上复现同样的漂移, 因此它不是本改动引入的;
  按该 gate 自己的提示, 应由有意变更检索行为的那次改动连同报告一起 `--write`。
