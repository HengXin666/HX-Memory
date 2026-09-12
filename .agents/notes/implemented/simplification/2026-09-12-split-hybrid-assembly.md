# Agent Note: 拆分 retrieval/hybrid.ts 的收尾逻辑到 assemble.ts

Status: implemented

## Problem

加入"图候选第二梯队"之后, `src/retrieval/hybrid.ts` 涨到 **421 行**, 超过 400 行上限,
`verify-structure` 直接失败。这不是数字洁癖: 该文件当时同时装着两件变化原因不同的事 ——

- **取数与融合**: 通道增删、权重、RRF (历史上改过多次);
- **收尾整理**: MMR 去冗余、预算裁剪、图候选补位、返回顺序 (排序缺陷改过三次)。

两者混在一起, 最长的那段会把另一段淹掉 —— 上一轮修"MMR 顺序被当排名"时就是在 400 行文件里
定位一段收尾逻辑。

## Decision

抽出 `src/retrieval/assemble.ts` (110 行), 只做"把已打分的候选整理成最终命中列表":

- 入参: `ScoredCandidate[]` (融合 + 演化链上溯之后) 与一组显式选项 (`limit` / `tokenBudget` /
  `mmrLambda` / `graphTierQuota` / `tier2Ids`) 加三个回调 (`tokensOf` / `resolve` / `whyOf`)。
- 出参: `RetrievalResult` (hits / tokens / dropped; degraded 由调用方回填)。
- 只依赖 kernel 的纯函数与类型, 不认识存储与宿主 (引擎层铁律)。

`hybrid.ts` 421 → 370 行, 收口为一次 `assembleHits(resolved, {...})` 调用。

顺带删掉一处死表达式: 上一轮留下的 `Math.max(limit, this.graphTierQuota > 0 ? limit : limit)`
恒等于 `limit`, 无实际作用。

## Alternatives considered

**抬高 400 行上限。** 上限是**决策**而非测量 (理由见 `verify-structure.ts` 注释: 超过它通常
意味着两个职责被塞进一个文件)。为一次改动改规则, 等于把规则变成可以随时绕开的东西。

**把收尾逻辑放到 `kernel/ranking.ts`。** 那里是**纯函数与类型**, 而收尾需要知道"哪些是规则通道"、
"演化链上溯后是谁"这类上下文, 放进 kernel 会把领域知识漏进最底层。

**不拆, 用 `// prettier-ignore` 或压缩注释压回 400 行以内。** 靠删注释达标是自欺 ——
行数只是症状, 两个职责同处一文件才是问题。

## Consequences

- `hybrid.ts` 回到 370 行, `verify-structure` 80 个源文件通过。
- 收尾策略现在有独立文件与独立测试面: 调 MMR lambda / 预算 / 图配额不必碰取数逻辑。
- `assembleHits` 是纯函数, 可以直接用假候选单测排序与补位规则, 不必构造 retriever。
- 端口契约不变 (`Retriever` / `SyncRetriever` 的方法签名未动), 因此适配层无需改动。

## Testing

- 行为不变已核对: 图专属 case 的命中路径仍为 2/4 由图通道给出 (与拆分前一致)。
- 全量 `vitest run`: 96 文件 / 686 用例全绿 (含 conformance 的图扩展契约)。
- `verify-structure`: 单文件 ≤ 400 行 / 重复率 / 端口纯度 / 单一事实源 全部通过。
