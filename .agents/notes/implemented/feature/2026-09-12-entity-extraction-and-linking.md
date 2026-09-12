# Agent Note: 实体抽取接入写入路径 (entities 从 0% 到可用)

Status: implemented

## Problem

真实库 80 条记忆的 `entities` 填充率是 **0%**, 75% 的条目孤立, 边只有规则推广产生的
`generalizes` 一种。两个根因, 都在代码里可查:

1. **`StructuredTurn` 根本没有 `entities` 字段** —— 结构化器再能干也无处可产出,
   `pipeline.enrich` 也就无从写入。字段不存在这件事, 靠"调提示词"是修不好的。
2. **自动捕获绕过了建边逻辑**。`planStructuralLinks` 只在 `facade.remember()` 里被调用,
   而日常对话沉淀走的是 `CapturePipeline.run → store.add` 直连存储 ——
   于是"聊出来的记忆"永远不建边, 只有工具显式保存的才有。

第 2 条解释了为什么图上只有规则边: 规则是推广器经 `facade` 写的, 走的是唯一那条会建边的路。

## Decision

- `StructuredTurn` 新增 `entities?: string[]`; 提示词要求抽"可复用的专名"
  (项目/文件/服务/库/组件), 明确禁止泛指词与整句。
- `llm-structurer` 对实体做规范化键去重 (小写比较、去空白、限长 40、上限 8) ——
  同一实体两种写法会让共现匹配失效。
- `CapturePipeline.run` 在落盘前调用新增的 `withStructuralLinks`: 读既有条目, 按
  `planStructuralLinks` 规划共现边并合并去重。
- 新增 `PipelineOptions.maxStructuralLinks` (默认 3, 0 = 关闭), 与 Facade 的默认一致。
- 启发式兜底**刻意不产 entities** (与不产 conclusion 同理): 规则没法可靠判断专名,
  错的实体会把不相关的记忆连成一团, 比没有边更糟。

## Alternatives considered

**只在提示词里加 entities, 不动 pipeline。** 字段仍会写进条目 (因为 enrich 会透传),
但**不会建边** —— 因为建边需要与既有条目比较, 而 pipeline 当时不做这件事。这条路只完成一半。

**在 pipeline 里重新实现一遍建边。** 与 `evolution/link.ts` 重复, 两处口径迟早漂移。
复用同一个纯函数, 只有"何时调用"不同。

**让捕获也走 `facade.remember()`。** 语义上最统一, 但 remember 会触发去重/演化/裁决一整套
判定, 捕获路径每轮都会跑 —— 代价与风险都明显更高, 且会改变既有写入语义。当前做法只加"建边"这一件事。

## Consequences

- 端到端实测 (脚本 stub 结构化器给共享实体): 两条记忆共享 `hybrid.ts` → 自动生成
  `relates` 边 (weight 0.75), 实体填充率 2/2, 边 1 条。
- 真实语料上以机器提取的候选实体模拟: 43/80 条获得实体, 新建 **133** 条边, 有边条目从
  极小基数升到 48/80 —— 图检索**终于有东西可扩展**。
- 写入路径多一次 `store.all()`。捕获频率低 (每轮最多一次), 且这是正确性所需; 若将来成为瓶颈,
  可换成"按实体反查"的索引查询。
- 建边失败不影响落盘 (增强不是门槛), 已有测试覆盖。

## 已知张力 (本次只测量, 未改默认)

边建起来之后, **图扩展的收益仍未被证实, 且代价明显**:

| 指标 | 图关闭 | 图开启 |
| --- | --- | --- |
| 全体 R@1 | **0.690** | 0.313 |
| 全体 R@10 | 0.947 | 0.949 |
| 带 secondary 的 6 个 case: 次级目标 R@10 | 0.889 | 0.889 (增益 +0.000) |

图候选的 gold 精确率只有 **8.5%** (50/588), 且把权重一路降到 0.05 时 R@1 仍只有 0.607
(关闭是 0.690) —— 说明它带来的是**主题邻居**而不是**答案**。

**但不改默认**: conformance 明确要求"从命中的种子出发, 把字面不相关的邻居召回并给出可审计的
why", 把图通道降为仅兜底会删掉这项设计能力。要动这条默认, 前提是先有一套**必须靠边才能答对**
的 case 集 —— 当前 171 个 case 里没有 (带 secondary 的 6 个目标字面本来就能命中)。
这个前提缺失本身就是下一步该补的东西。

## Testing

- `tests/s2/entity-linking.test.ts` (新增 5 条): 实体写进条目; 共享实体自动建 `relates` 边且不自指;
  无实体无标签不建边; `maxStructuralLinks=0` 可关闭; 建边抛错仍正常落盘。
- 真 LLM 验证提示词: 输入含 `hybrid.ts`/`MMR` 的问答 → 抽出 `["hybrid.ts","MMR"]`;
  含 `bge-small-zh-v1.5` → 抽出模型名与 `embedding-http.ts`; 无结论的讨论 → `entities: []`。
- 全量 `vitest run`: 96 文件 / 684 用例全绿; `tsc --noEmit` 无错误。
