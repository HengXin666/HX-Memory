// kernel/rule-shape.ts — "这条 rule 是不是机器生成的占位草稿" 的单一判据。
//
// 为什么需要独立一份 (真实缺陷): 推广服务在没有 AI 抽象器可用时会回退启发式, 产出的"规则"
// 形如 `经验: <主题> 相关的 N 条实例已沉淀, 建议复核提炼为跨项目规则` —— 它只说明"这个主题
// 有 N 条实例", **不含任何可执行的约束**, 本意是提示人去重写 (面板里有"需人工改写"的标注)。
// 但一旦被一键确认, 它就和真正提炼出来的规则一样落成 scope:global 的 rule, 而规则在
// always-on 里得分最高 (100 + importance) —— 实测 10 条占位草稿把 400 token 的保底预算吃光,
// 真正的架构决策一条都注入不进来。
//
// 判据只能是**文本形状**, 不能是 source: 真规则与占位草稿的 source 完全同形 (都是
// `generalizer:panel:<批次时间>`), 区分不了。而"人把它重写成真规则"之后形状必然改变 ——
// 这正是要的语义: 重写过的留下, 没重写的挡掉。
//
// 放在 kernel 层: 纯函数、零依赖, 被 L2 的生成方 (generalize) 与 L2 的消费方 (trigger) 共用。
// 生成与识别同源, 模板只有这一份 —— 分成两处必然漂移 (由 tests/s1/rule-shape.test.ts 钉住)。

/**
 * 占位草稿的文本模板 (生成与识别**同源**: generalize 用它产出, policy 用正则识别)。
 * @param theme     聚类主题
 * @param instances 去重后的实例条数
 */
export function heuristicRuleText(theme: string, instances: number): string {
  return `经验: ${theme} 相关的 ${instances} 条实例已沉淀, 建议复核提炼为跨项目规则`;
}

/** 锚定匹配上面的模板 (主题允许任何非换行字符)。 */
const HEURISTIC_RULE_RE = /^经验: [^\n]+ 相关的 \d+ 条实例已沉淀, 建议复核提炼为跨项目规则$/;

/** true = 机器生成的占位草稿 (尚未被人重写) → 不进 always-on 常驻通道。 */
export function isHeuristicRulePlaceholder(content: string): boolean {
  return HEURISTIC_RULE_RE.test(content.trim());
}
