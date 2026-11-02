# Agent Note: 记忆按时间与置信度衰减, 同话题新压旧

Status: implemented

Decision-ID: temporal-confidence-decay

## Code

- `src/kernel/temporal.ts`
- `src/trigger/always-on.ts`
- `src/retrieval/hybrid.ts`
- `src/app/facade-queries.ts`
- `src/adapters/dsh/gateway-injection.ts`
- `scripts/eval/derive-decay.ts`
- `scripts/panel-detect.ts`

## Problem

用户原话: 「你不可能 1 个 10 年前的事情比你昨天的事情还要重要吧」「明明仓库在疯狂变化, 总不能拿之前的东西来说明昨天我新定的规则」。

改之前三处都不看时间, 或者时间被反向利用:

- `HALF_LIFE_DAYS.rule = Infinity`, decision 365 天, 规则在排序里永不衰减;
- always-on 给规则打 `100 + importance`, 同分按 id 字典序, 去年和昨天的规则谁先注入取决于 id;
- 衰减基线是 `lastHitAt ?? validAt`, 而 `lastHitAt` 由每轮注入回调刷新。规则每轮都被注入, 所以永远是新的。真库规则平均 reinforcement 122, 是 decision 的 11 倍, 越老越难忘。

## Decision

三层, 各管一件事 (`src/kernel/temporal.ts`):

1. 保持率 `R(age) = floor + (1 - floor) · 2^(-age/H)`, age 从 `max(validAt, confirmedAt)` 起算, 不看 `lastHitAt`。H 与 floor 按 kind 分档; 规范性 kind (rule/decision/preference) 的 H 由 `scripts/eval/derive-decay.ts` 从用户历史对话推导。floor > 0: 没被推翻的老规则只排后面, 不凭时间消失。
2. 同话题新压旧: 同 kind、同项目, 重合系数 ≥ 0.5, 或 ≥ 0.35 且新的一条带改写信号 (改为/不再/以后…), 旧的 ×0.1 并且不进常驻注入, 在 blocked 里报 `superseded`。这一层不靠曲线, 只差一天也成立。
3. 规范性条目在 `compositeScore` 里不再吃 reinforcement; always-on 收到 `now` 时整体乘 R。`now` 缺省时行为不变, 老调用点与老测试一字不改。

数据不动: 不写 shadow、不改 status, 只改排序与注入。规则仍只由人改 (ADR-003)。

## Alternatives considered

**什么都不做 / 复用现有 `HALF_LIFE_DAYS`。** 最强理由: 已有半衰期表和 `timeDecayFactor`, 只需把 rule 从 Infinity 改成有限值。否决: 基线仍是被注入刷新的 `lastHitAt`, 改了半衰期也会被每轮注入抵消; 而且 `consolidate.ts` 用同一张表判过期, 有限半衰期会让机器自动过期用户确认过的规则。

**复用 `heuristicAdjudicator` 的 supersede, 落成 status 变更。** 最强理由: 冲突裁决端口已存在, 可审计。否决: 它对 rule 明确不取代 (人工闸门), 且落盘是不可逆的数据变更; 这里只需要排序层的「新的优先」, 可随参数回滚。

**用 Jaccard 判同话题。** 规则常是短句对长句, 真库同一条测试纪律 Jaccard 0.337、重合系数 0.682。

**极性相反也算改写。** 真库在 0.35 附近只抓到「原则 vs 已实现」这类互补对, 误压。

## Consequences

**换来的**: 「昨天定的」在数值上压过「去年定的」(同 importance 时 R 0.974 vs 0.200); 被同话题改写的旧规则退出常驻注入, 面板可见。

**付出的**: 同话题判据是词面的, 措辞完全不同的改写抓不到 (真库 95 条规范性条目只判出 2 对), 这部分只靠时间衰减排序。参数随历史推导结果更新, 要重跑脚本。

**明确放弃的**: 不按时间删除或过期任何条目; `HALF_LIFE_DAYS` 与 consolidate 的过期语义保持原样。

## Testing

- `tests/s1/temporal.test.ts`: 曲线端点与单调性; 昨天 vs 去年的排序比值; 老规则被命中 500 次也翻不了盘; 同话题改写被压且只差一天; 互补的两条不被压; always-on 被压的不注入且与输入顺序无关; 不给 now 时行为不变。
