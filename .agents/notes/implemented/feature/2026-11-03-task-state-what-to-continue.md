# Agent Note: task-state 回答「继续什么」, confidence 改为对当前任务判断的确定度

Status: implemented

<!--
本记录遵循 .agents/notes/AGENTS.md 与根 AGENTS.md 的 Agent Notes 红线:
- 一条决策一篇 note; Code 逐行列仓库相对精确路径, 每个直接父目录只选一个代表文件;
- 代表文件在声明顶部的多行块注释里反向引用本 note 的完整仓库相对路径;
- 代码与 note 同一 diff 配对; Alternatives considered 含"什么都不做"与"复用现有", 每项先给最强理由再否决.
-->

Decision-ID: task-state-what-to-continue

## Code

- `src/kernel/task-state.ts`

## Problem

用户在长会话里经常只说 "next / 继续 / yes / 嗯"。注入层需要知道"当前任务是什么", 才能按任务取记忆, 用户原话:「必须是按当前任务, 基于当前任务去决策」。

`computeTaskState` 初版用整个 40 轮窗口算动作、路径和 confidence。3 段真实 DSH 会话抽样显示三个错误: 低信息的 "yes" 被判为 action=新增、confidence 0.9; "next" 被判为 action=修改、confidence 0.9; 一条明确的"修代理"请求 confidence 也是 0.9。窗口里历史路径越多分越高, 和这一句话本身的确定性无关。一修只看当前轮之后, "yes / next" 降到 0.1, 但这又丢掉了"继续的是哪件事"。

## Decision

`TaskState` 字段语义:

- `action` / `modules` / `files` / `error` 仍从窗口里算, `evidence` 说明每个字段来自当前轮还是历史。
- 新增 `continuing` / `previousAction` / `previousTurn` / `previousFiles` / `blockedOn`: 当前轮是续接短句时, 由 `src/kernel/task-continuation.ts` 从逐条信号里找出上一件有明确动作的用户轮, 以及其后没闭合的报错。
- `goal` 在续接时说清"接着做的是哪件事, 卡在哪"。

`confidence` 重新定义为**对当前任务判断有多确定**, 不是"这句话信息量多大" (`confidenceOf`):

- 续接短句: 历史里有明确上一任务且有文件 0.8, 只有动作 0.6, 历史空白 0.1;
- 非续接轮只看当前轮: 动作 + 路径 0.8, 只有其一 0.4, 都没有时短句 0.1、其余 0.2。历史路径多少不加分。

## Alternatives considered

**什么都不做, 保留窗口统计口径。** 最强理由: 实现最简单, 窗口统计在单一任务的会话里大体正确。否决: 真实抽样里低信息 "yes / next" 都拿到 0.9, 下游会按错误的任务高置信注入; 字段本身也回答不了"继续什么"。

**复用现有实现, 只保留一修 (只看当前轮)。** 最强理由: 规则直观, 当前轮没信息就低分, 不会被历史带偏。否决: 续接短句恰恰是"当前轮没信息、但任务很明确"的情况, 一修把它打成 0.1 等于说"不知道在干什么", 和用户意图相反。

**让 confidence 继续表示信息量, 另加一个字段表示任务确定度。** 最强理由: 不改既有字段语义, 旧断言不用动。否决: 下游只读一个 confidence, 两个分数会让调用方各取一个, 口径分裂; 信息量本身没有独立用途。

## Consequences

**换来的**: "next / 继续" 在有明确上一任务时给出 0.8 并带上上一任务的动作、原话和文件; 无从判断的短句仍是 0.1。

**付出的**: `tests/kernel/task-state.test.ts` 改了 3 条旧断言 (旧断言把 confidence 当信息量), 新增 3 条。`task-state.ts` 已到 400 行上限, 续接判定因此拆到同目录独立文件。

**明确放弃的**: task-state 目前未接线到注入路径 (改前即悬空), 本记录只定义语义, 不包含接线; `findLastIndex` 的 lib 报错是原有代码, 本次不修。

## Testing

- `tests/kernel/task-state.test.ts` (15 项): 80 条历史 + yes/next 时 confidence ≥ 0.8、action 来自历史上一任务且不计入 fromCurrentTurn; 历史空白 + 嗯 → 0.1; 当前轮口径各档。
- 全量 `npx vitest run`: 199 files / 1502 tests passed。
