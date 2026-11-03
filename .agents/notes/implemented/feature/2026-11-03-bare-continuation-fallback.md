# Agent Note: 裸「继续 / next / 嗯」由 task-continuation 兜住, 不扩意图正则

Status: implemented

<!--
本记录遵循 .agents/notes/AGENTS.md 与根 AGENTS.md 的 Agent Notes 红线:
- 一条决策一篇 note; Code 逐行列仓库相对精确路径, 每个直接父目录只选一个代表文件;
- 代表文件在声明顶部的多行块注释里反向引用本 note 的完整仓库相对路径;
- 代码与 note 同一 diff 配对; Alternatives considered 含"什么都不做"与"复用现有", 每项先给最强理由再否决.
-->

Decision-ID: bare-continuation-fallback

## Code

- `src/kernel/task-continuation.ts`

## Problem

续接短句 ("next / continue / ok / yes / 继续 / 接着 / 下一步 / 嗯 / 好 / 行") 本身没有动作词也没有路径。task-state 只看当前轮时, 这些轮次会被判成"不知道在干什么"; 看整个窗口时, 又会被历史里出现最多的路径带偏。需要一个判据, 明确"这句话只是在说接着干", 并找出接着干的是哪件事。

同时有一个诱惑: 触发层 `src/trigger/intents.ts` 已有 session-continuation 意图, 把这些裸词加进它的正则看起来最省事。

## Decision

独立纯函数文件 `src/kernel/task-continuation.ts` (无 IO, 不 import task-state, 避免环依赖), 只吃 task-state 已逐条算好的信号:

1. `isContinuationUtterance`: 去掉尾部标点后, 命中固定续接词表, 或是 ≤ 6 字且以"继续 / 接着 / next / continue"开头, 即判为续接短句。只用集合查表和一条锚定前缀, 不做模糊匹配。
2. `findContinuation`: 从当前轮往回找最近一个**有明确动作**的用户轮作为上一任务; 收集那一轮到当前轮之前涉及的文件 (用户亲口点名的排前, 至多 5 个); 若其后有工具报错且之后没有修复迹象 (已修复 / fixed / passed / 通过 …), 记为 `blockedOn`。

续接词表只在这里使用, 与意图正则无关, **不扩** `src/trigger/intents.ts`。原因: 意图正则决定"这轮要不要按意图召回记忆", 它的模式按"提问形状"标定 (见 `intent-shape-vs-topic`), 置信度 = 1 - 0.5^命中数。把 "嗯 / 好 / ok / yes" 这类几乎每轮都会出现的应答词加进去, 意图门控会对大部分短回复恒真, 在新的意图优先顺序下每一句"好的"都会触发意图召回并叠加 always-on 预算。而且"继续什么"是任务状态问题, 不是"要不要查记忆"的问题, 两者的判据和误判代价都不同。

## Alternatives considered

**什么都不做。** 最强理由: 一修后续接短句 confidence 0.1, 下游可以把低分当作"沿用上一轮决策", 不需要新代码。否决: 下游拿不到"上一轮是哪件事、卡在哪", 只能靠模型自己翻上下文, 而长会话里这正是它容易错的地方。

**复用现有实现: 把续接词加进 `src/trigger/intents.ts` 的 session-continuation 意图。** 最强理由: 已有意图、置信度和账本通路, 不新增文件。否决: 见 Decision, 应答词会让意图门控对多数短回复恒真, 破坏意图层的精度标定; 意图层也只给出"命中了", 不给出上一任务和阻塞点。

**在 task-state.ts 内部实现。** 最强理由: 少一个文件。否决: task-state.ts 已到 400 行上限; 续接判定只依赖逐条信号, 独立成纯函数更容易单测。

## Consequences

**换来的**: 续接短句能稳定拿到上一任务的动作、原话、涉及文件和未闭合报错; 意图正则的精度不受影响。

**付出的**: 续接词表需要随表达习惯维护; "好 / 对 / 可以"在非续接语境 (例如回答是非题) 也会被判为续接, 此时 task-state 回落到上一明确任务, 由 confidence 档位表达确定度。

**明确放弃的**: 不做语义判断 (不调模型); 不改意图层任何模式。

## Testing

- `tests/kernel/task-state.test.ts`: 通过 task-state 覆盖续接短句各档, 包括有上一任务 + 文件、仅动作、历史空白, 以及报错已闭合时 blockedOn 为空。
- 全量 `npx vitest run`: 199 files / 1502 tests passed。
