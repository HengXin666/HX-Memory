# Agent Note: 检索目的分层 (inject/recall) 与 always-on 预算分仓

Status: implemented

## Problem

面板的"记忆浏览"搜索框里, 搜任何内容前几条永远是那几条已确认规则, 与查询毫无关系;
用户因此怀疑"检索是坏的 / 记忆没更新"。同时 always-on 通道把 6 条规则 (约 300 token)
按"规则 100 分 + importance"排在前面写满 400 token 预算, 真正随任务变化的关键事实
(架构决策、项目约定) 一条都注入不进来。

两个症状的根因是同一件事: **一套检索语义被两种目的复用**, 且预算没有分仓。

1. 规则保底通道对所有请求无条件候选, 且不受覆盖率过滤 —— 这对"注入不变量"是对的,
   对"用户主动搜最相关的记忆"是错的: 规则通道权重 ×1.5 + 命中 boost 0.5, 数学上
   让每条规则的 RRF 分都压过 BM25 第一名, 与查询相关性完全无关。
2. `selectAlwaysOn` 按单一分数排序后顺序填预算, 规则分数恒高, 于是规则吃掉全部预算。

## Decision

**按检索目的分层** (`RetrievalRequest.purpose`):

- `"inject"` (**默认, 保持既有行为**): 规则保底通道开启, 规则参与 boost。
  用于"不变量必须永远在场"的注入路径。
- `"recall"`: 规则保底通道默认关闭, 规则不参与 boost。用于一切"要最相关的几条"的路径 ——
  面板浏览 (`memoryQuery`)、`memory_search` 工具、`RecallService` 的按需召回、
  触发层的意图召回、写入期的近邻裁决。

两者都不删除 rules 通道: 显式传 `channels.rules.enabled = true` 仍可覆盖默认;
规则**相关**时照常通过该通道被召回 (关掉的是"保底", 不是"规则")。

**always-on 预算分仓** (`AlwaysOnOptions.ruleBudgetRatio`, 默认 0.6):

- 规则组最多占 `floor(budget × ratio)`, 其余预算留给事实/偏好/决策;
- 只有两组都有候选时才切分 (单组存在时用满, 不让分仓变成浪费);
- `ruleBudgetRatio: 1` 可恢复旧的"规则优先填满"行为。
- 同时把 `scope:"agent"` 的 fact/preference 纳入 always-on 候选: 它们是**跨工作区共享层**
  (不属于任何项目), 对每个项目都应常驻。

## Alternatives considered

**只调规则通道权重 (1.5 → 1.0) 或去掉 boost。** 治标: 规则仍是"无关也强行候选",
在规则数量增长后同样会霸榜; 而且会削弱注入路径真正需要的保底强度。

**把规则的保底候选改成"覆盖率低于阈值就不进候选"。** 这等于取消保底通道 ——
与"注入一份跨项目约束"的目的冲突 (而且是用户已确认的规则, 被相关性筛掉很难解释)。

**只给面板另开一条纯检索路径, 不动 `RetrievalRequest`。** 会把"检索语义"复制成两份
(一份带保底、一份不带), 而后端已有 Facade 作为唯一入口的设计正是不想有第二份语义。
用一个显式字段表达目的, 比多一条平行路径可审计。

**预算按"先到先得 + 动态抵扣"而不是硬分仓。** 动态抵扣在规则多的时候仍会逐步吃掉事实;
硬上限让"事实至少有预算"成为可断言的性质 (有测试钉住)。

**给 `agent` scope 单独开一个 always-on 子预算。** 过度设计: agent scope 的 fact/preference
本身数量少、价值高, 与项目事实同组竞争即可, 不必再加一层预算维度。

## Consequences

- 面板/工具搜索恢复"相关性排序"的直觉; 规则在相关时仍会出现。
- 注入侧行为**没有退化**: `purpose` 默认 `"inject"`, 既有调用方零改动即保持保底。
  `tests/s2/recall-separation.test.ts` 同时钉住"recall 不霸榜"与"inject 仍保底"两侧。
- always-on 的固定成本下降: 规则不再独吞 400 token, 项目事实获得保底配额。
- 代价: 多了一个需要两处同时正确理解的字段 (`purpose`); 已在 `kernel/ports.ts` 的
  JSDoc 与两篇 Note 里写明用途边界。

## Testing

`tests/s2/recall-separation.test.ts` (8 项): 无关规则在 recall 下不出现; 相关规则仍被召回;
inject (默认) 仍带保底; 显式 `channels.rules.enabled` 可覆盖; 预算分仓下事实能进入注入;
单组时用满预算; `ruleBudgetRatio: 1` 回到旧行为; agent scope 事实对每个项目常驻。
回归: 既有 `tests/s1/trigger-policy.test.ts`、`tests/s2/trigger-injection.test.ts`、
`tests/s2/recall-rules.test.ts` 在默认 `inject` 语义下全部保持通过。
