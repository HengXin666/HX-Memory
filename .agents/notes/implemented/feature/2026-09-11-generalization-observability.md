# Agent Note: 推广批次的可观测性 (状态视图 + 漏斗报告 + 聚类覆盖)

Status: implemented

## Problem

"运行推广批次"是记忆系统的核心闭环, 但它在面板上只回一个 `proposed` 计数: 用户点一下,
看到 "0 条提议", 无法区分是哪一段断了 ——

- 库里根本没有 lesson/pattern/decision 候选?
- 候选全被队列里已有的提议覆盖了 (去重生效, 属于正常)?
- 聚类主题字典没命中任何一条 (真正的"效果差")?
- 有候选但 AI 抽象器不可用, 只产出了需要人工改写的启发式草稿?

四种情况在旧接口下**完全同形**。结果是这个功能被判定为"没用", 而真实原因不可见。
另外主题字典只有 9 个主题, "接口设计/性能/依赖/文档/流程/类型"这类同样常见的工程经验
全部静默不聚簇, 进一步放大了"跑了没效果"。

## Decision

**把漏斗的每一段暴露出来。**

1. `GeneralizationRunReport` (`kernel/types.ts`): `at / considered / coveredSkipped /
   clusters / proposed / usedLlm / tookMs / error`。
   `runRecent` 由"返回裸提议数组"改为**返回这份报告**; `runBatch` 记录 `usedLlm`。
2. `GeneralizationStatus` + `status()`: `abstractor` (AI 是否接上) + `lastRun` + 队列三段计数。
   新增 Remote `generalizationStatus` 供面板顶部状态条轮询。
3. `runGeneralization` 的返回值改为 `GeneralizationRunReport & { ok }` —— 失败时也返回
   形状完整的报告 (`error` 非空), 面板只读字段即可, 不必判空。
4. **主题字典扩充** (9 → 18): 增加 api / performance / dependency / docs / process /
   tooling / ui / typescript / error。纯加法, 不改变既有主题的判定。
5. **共享标签回退簇**: 未命中主题词、但同一 AI 结构化标签出现在 **>= 2** 条候选上的,
   归入 `tag:<name>` 簇。下限 2 是防止退化成"每条一个簇"。
6. **单实例簇不产提议** (含 LLM 路径): 推广的定义是"从多条实例提炼共性", 去重后不足 2 条
   没有共性可抽象。真实踩坑: 一条用户指令 ("帮我修改一下当前项目…") 被 structurer 归成
   `decision`, 单条成簇后被**原样抄成规则**进了审阅队列 —— 用户唯一的选择是驳回。
   旧启发式对单实例直接返回原文 (`{ rule: texts[0] }`), 这是"把一句话当规则"的直接来源。

## Alternatives considered

**只把 proposed 计数换成"更详细的日志"。** 日志不在产品界面里, 用户看不到, 等于没解决
"不可见"的问题; 而状态视图是可以被 UI 直接消费的结构化数据。

**把报告塞进 review 队列文件 (持久化)。** 队列文件的语义是"待人工确认的提议",
塞运行报告会让"队列"这个真相源混杂两种生命周期的东西; 报告是**派生运行状态**,
进程内保留最近一次即可 (与 `lastTriggerDecision` 同构)。

**给聚类换成语义聚类 (embedding)。** 方向正确但成本与风险都更高 (需要嵌入器可用、
阈值要重新标定), 而当前问题是"字典太窄 + 没有回退", 先做零依赖的覆盖扩充与标签回退,
把语义聚类留给后续独立决策。

**标签回退不设下限 (任意标签都成簇)。** 会产生大量单条簇 → 提议数量暴涨且无可复核价值;
`>= 2` 让"共现"成为最小的证据门槛。

**单实例也允许提议, 只要 AI 能把一句话改写得更通用。** 这会让"用户的一句任务指令"变成
待审规则 (已实测发生); 而且没有第二条实例时, "提炼"与"抄写"没有可验证的差别。宁可少提议。

**让面板在无 abstractor 时禁用批次按钮。** 启发式草稿仍有价值 (它把散落经验聚成一条待改写
的规则草稿), 禁用会把"降级"误伤成"不可用"; 正确做法是**显式标注 AI 未启用**。

## Consequences

- 用户能看到"候选 N 条 / 跳过 M 条 / 聚成 K 簇 / 产出 P 条 / 是否用了 AI / 耗时",
  "0 条"不再是无信息的失败。
- `runRecent` 的返回类型变了 (破坏性): 调用方从 `QueuedProposal[]` 改为读报告字段。
  已同步 gateway、面板与全部相关测试。
- 扩充字典与标签回退会**提高**提议产量 —— 这是有意为之 (覆盖优先), 人工闸门仍在,
  机器永不自动确认。
- 代价: `status()` 在每次调用时读一次队列文件 (`listQueue`), 面板轮询 5s 一次可接受;
  若将来队列规模变大, 可加一层与队列文件 mtime 绑定的缓存。

## Testing

`tests/s2/generalizer-trigger.test.ts`: 报告字段 (considered/coveredSkipped/proposed)、
"被覆盖"可在漏斗里读到、空候选返回可解释报告、`status()` 报告 AI 可用性与队列计数。
`tests/s2/generalizer-hardening.test.ts`: 驳回后重新提议仍成立 (语义未变, 断言改用报告字段)。
`tests/s1/cluster.test.ts`: 扩充后的字典覆盖接口/性能/依赖/类型主题; 共享标签 (>=2) 成簇
而单次标签不成簇。
