# Agent Note: 机器生成的占位草稿不进 always-on 常驻通道

Status: implemented

## Problem

always-on (400 token 的保底通道) 被**机器生成的占位文本**占满, 真正的规则一条都注入不进来。

推广服务在没有 AI 抽象器可用时会回退启发式, 产出的"规则"形如
`经验: <主题> 相关的 N 条实例已沉淀, 建议复核提炼为跨项目规则` —— 它只说明"这个主题有
一簇实例", **不含任何可执行约束**, 本意是提示人去重写。但一键确认后, 它就和真正提炼出来
的规则一样落成 `scope: global` 的 rule。

实测 (live store): 17 条 rule 里有 **10 条**是这个形状 (api/security/memory/concurrency/ui/
testing/docs/timeout/storage/process), 全部 `confirmed_by = user:dsh-web`, 且全部在
2026-09-15T14:10:3x–4x 的同一分钟内被确认。规则在 always-on 里得分最高 (100 + importance),
因此这 10 条把 400 token 预算吃光 —— 保底通道只剩噪声。

判据**不能**用 `drafted`: 我核查了 review 队列的 17 行, 这 10 条 confirmed 行的
`proposal.drafted` 全是 `null` (队列行写在那次改动之前), 而 `parseProposalLine` 有意把
"缺字段"当"未知"(不给历史提议扣帽子)。同样地, `source` 也区分不了 ——
真规则与占位草稿都是 `generalizer:panel:<批次时间>`。

## Decision

按**文本形状**判定, 且**生成与识别同源**:

- 新增 `kernel/rule-shape.ts`: `heuristicRuleText(theme, n)` 产出模板,
  `isHeuristicRulePlaceholder(content)` 用同一形状的正则识别。纯函数、零依赖, 放 kernel
  层以便 L2 的生成方与消费方共用, 且不违反分层铁律。
- `generalize/service.ts` 的 `heuristicRule()` 改为调用 `heuristicRuleText` ——
  模板只有这一份, 不会漂移。
- `selectAlwaysOn` 在规则分支里先挡掉占位草稿, 再走原有的 `scope: global && confirmedBy`
  治理闸门。

语义边界: **人把它重写成真规则之后形状必然改变**, 于是自然留下 —— 这正是想要的:
重写过的保留, 没重写的挡掉 (而不是"把一条 rule 永久拉黑")。
挡的是"常驻通道", 不是"这条记忆": 它仍可被 `memory_search` / 意图召回按相关性取回。

## Alternatives considered

**用 `proposal.drafted` 当判据。** 已实测否掉: 这 10 条的 `drafted` 是 `null`,
一个字都挡不住。而且队列是跨批次的, 落盘时没有这个字段的历史行永远补不上。

**用 `source` 前缀 (如 `generalizer:panel:`) 判定。** 真规则同形, 会**误杀**所有
AI 提炼的规则 —— 那比漏挡严重得多。

**写迁移脚本把这 10 条改成 `status: shadow` / 删除。** 数据是用户确认过的, 由代码按形状
动态挡掉是可解释且可逆的 (人重写后自动回来); 批量改用户数据不可逆, 且下次推广又会生成新的
占位草稿 —— 治的是症状。**不做**。

**在确认入口就不允许确认占位草稿。** 更早的防线, 但会改变人审的语义 (用户"确认"一条
待重写的草稿可能是明确的意图); 本次只保证它**不污染保底通道**。面板已有的"需人工改写"
标注是那一层的提示。

**只靠 `ruleBudgetRatio` 压低规则占比。** 治不了: 草稿条数够多时仍能填满给规则的那一份,
而且它挤掉的是"其他真规则", 不是"预算留给事实"。

## Consequences

换来的: always-on 里的规则全部是可执行的真规则; 实测 live store 从"9 条含 1 条草稿"变为
"9 条全是真规则 + 项目条目"; 保底通道恢复"给不变量"的语义。

付出的: always-on 少了一个"提醒某主题有实例沉淀"的信号 (那是给**人**看的, 人审界面也在显示它);
多了一份 kernel 模块与一条正则 —— 正则锚定两端, 宁可漏挡 (一条草稿混进来) 也不错杀
(把真规则挡掉), 这一点由测试钉住。

## Verification

- `tests/s1/rule-shape.test.ts`: 生成即被识别 (同源); 真规则不误判; 缺段/非数字不算;
  重写后不再是草稿。
- `tests/s2/recall-separation.test.ts`: 3 条草稿 + 1 条真规则 → 只留真规则; 全是草稿 → 空。
- live store 复核: `alwaysOn` 结果里不再有 `已沉淀` 字样。
