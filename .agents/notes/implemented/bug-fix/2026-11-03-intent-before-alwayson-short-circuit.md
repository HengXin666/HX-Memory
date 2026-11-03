# Agent Note: 触发层短路顺序改为意图优先, always-on 退为叠加

Status: implemented

<!--
本记录遵循 .agents/notes/AGENTS.md 与根 AGENTS.md 的 Agent Notes 红线:
- 一条决策一篇 note; Code 逐行列仓库相对精确路径, 每个直接父目录只选一个代表文件;
- 代表文件在声明顶部的多行块注释里反向引用本 note 的完整仓库相对路径;
- 代码与 note 同一 diff 配对; Alternatives considered 含"什么都不做"与"复用现有", 每项先给最强理由再否决.
-->

Decision-ID: intent-before-alwayson-short-circuit

## Code

- `src/trigger/policy.ts`

## Problem

`TriggerPolicy.decide` 原先把 `hasAlwaysOn` 分支放在最前并直接 return (要么 always-on, 要么同话题时 skip-similar)。线上恒有跨项目已确认规则, `src/kernel/binder.ts` 里 `hasAlwaysOn = alwaysOnIds.length > 0` 恒为真, 于是"意图门控"和"话题切换重查"两个通道在结构上不可达。

触发账本 (`~/.dsh/hx-memory/schedule/*.jsonl`, 1800 行) 实测: always-on 992 行, skip-similar 752 行, mode=intent 0 行。detectIntent 其实命中过 112 行, 其中 39 行"命中 session-continuation 却被判成 always-on 已注入过而跳过", 结果这一轮什么都没注入。用户说"继续 / 上次为什么"这种恰恰最需要历史的轮次被判重吞掉了。

## Decision

决策逻辑抽成纯函数 `decideFromSignals` (只吃已算好的 detected / drift / hasAlwaysOn / lastInjectedAt, 不碰原文), `decide` 只负责算信号再委托。短路顺序按"当前任务优先":

1. 意图命中且置信度过门槛: mode=intent。always-on 作为**叠加**, 预算 = intentBudget + alwaysOnBudget; 已注入过的常驻条目由 binder 的差量过滤去掉, 意图召回的条目照常进来。
2. 上一轮注入过且话题切换 (drift ≥ driftThreshold): mode=drift-refresh, 同样叠加 always-on 预算。
3. 有 always-on、上一轮注入过、同话题、且**未命中意图**: skip-similar。判重只在这一步出现。
4. 有 always-on (会话首轮 / 从未注入过): mode=always-on。
5. 其余: skip-no-signal。

没有 always-on 时行为与旧实现逐分支一致。纯函数单独暴露是为了能用同一个核心回放账本行 (账本只记了 intent / confidence / topicDrift, 没记原文), 证明线上真实输入在新顺序下走到哪个 mode。

## Alternatives considered

**什么都不做。** 最强理由: always-on 保底本身在工作, 规则每轮都能到达模型, 改顺序会改变线上注入分布和预算, 并要动既有测试。否决: 意图和话题切换两个通道在线上是死代码, 账本里 43 行明确的"继续 / 问理由"轮次一条历史都没注入, 这正是触发层要解决的场景。

**复用现有实现, 只在 always-on 分支里补一次意图召回。** 最强理由: 改动面最小, 不动分支顺序, 旧测试一行不改。否决: 那样 skip-similar 的提前 return 仍会吞掉同话题里的意图命中 (账本 52 行属于这一类), 而且 mode 字段仍记成 always-on / skip-similar, 账本无法区分"保底注入"和"按意图召回", 可观测性比现在差。

**把 always-on 也纳入意图门控 (没意图就不注入)。** 最强理由: 预算最省。否决: 模型没意识到要查时就失去保底, 违背 `trigger-layer-four-channels` 的核心前提。

## Consequences

**换来的**: 账本回放 (同一 `decideFromSignals`, hasAlwaysOn=true) 由 intent 0 / drift-refresh 0 变为 intent 116 / drift-refresh 756; 原先 43 行命中意图却没注入的轮次全部变为 mode=intent, inject=true。

**付出的**: 意图命中轮次的预算从 intentBudget 变为 intentBudget + alwaysOnBudget (默认 700 token)。drift-refresh 的 756 行旧逻辑也会注入, 注入次数不变, 只是给意图召回留出预算。

**明确放弃的**: 不改 `src/trigger/intents.ts` 的意图正则与置信度公式; 漂移阈值不变。

## Testing

- `tests/s1/trigger-policy.test.ts`: 新增 4 条。intent 不被 always-on 吞且预算叠加为 700; 账本 39 行形状的回归; hasAlwaysOn=true 时 drift-refresh 可达; `decideFromSignals` 与 `decide` 同口径。原有 13 条不改, 全部通过。
- 全量 `npx vitest run`: 199 files / 1502 tests passed。
