// capture/signals.ts — "这段文本该落成什么 kind" 的**判据集合** (纯逻辑, 无 IO)。
//
// 为什么从 engine.ts 拆出 (§710 行数上限的又一次触发): 信号词表与 kind 推断是**一类变化**
// (它们随"什么算教训/决策/偏好"的认知变), 而捕获编排是另一类变化 (随闸门与预算策略变)。
// 混在一个文件里时, 上面那类变化会把下面那类挤到 400 行之外 —— 那正是它触发上限的原因。
//
// ## 判据的**优先级**是这套设计里最容易搞错的地方
//
// `inferKind` 的顺序不是随手排的, 每一条都有实测依据 (见下方逐条注释)。最要紧的一条:
// **负面/纠正信号排在最前** —— 被骂的那一轮往往同时含决策词与指令词, 排在后面就永远轮不到它,
// 实测后果是真库里 27 条辱骂原话落成了 `decision`。
import type { MemoryKind } from "../kernel/types.ts";
import type { NegativeSignal } from "../kernel/negativity.ts";

/** 负面信号判定的注入面 (可选: 不传 = 关掉这条路, 行为与旧版逐字一致)。 */
export interface CaptureNegativity {
  /** 判定一段文本 (实现方缓存编译后的词表; 不要在每条文本上重编)。 */
  detect(text: string): NegativeSignal;
  /**
   * 把负面信号换成**可沉淀的教训正文**。
   *
   * 为什么必须由调用方注入而不是本模块自己调: 词表是可配置的 (设置项), 而这里是纯内核
   * (无设置、无 IO) —— 注入让"配置从哪来"留在适配层, 内核只依赖一个函数形状。
   */
  lessonDraft(signal: NegativeSignal, text: string): string;
}

/** 显式记忆指令 ("记住: X") —— 优先级最高, 是用户的直接命令。 */
export const EXPLICIT_PATTERNS: RegExp[] = [
  /记住[:：]?\s*(.+)/,
  /记一下[:：]?\s*(.+)/,
  /记到记忆里[:：]?\s*(.+)/,
  /记住这个[:：]?\s*(.+)/,
  /记下[:：]?\s*(.+)/,
];

export const LESSON_SIGNALS: RegExp[] = [
  /踩坑|教训|不要再|下次要|注意并发|注意幂等|注意超时/,
  /concurrency|idempoten|race condition|timeout|deadlock/i,
];

/**
 * "决策"类信号。
 *
 * ⚠ 2026-09-18: 移除裸词 **"采用"** —— 它作为**祈使/需求**出现时 ("请采用 X") 会被误判成
 * "用户采纳了 X"。实测 "刷新请采用局部更新" 落成 decision, 而真库里 content 与某条用户提问
 * 完全相等的自动捕获条目有 29 条 (18%), 这条误判是主要来源之一。
 * 判据改为**决策本体**: "决定/敲定/定稿/方案是" 这类词本身就表示"选了", 不需要"采用"凑数。
 */
export const DECISION_SIGNALS: RegExp[] = [
  /决定|选择|选用|改用|替换为|方案是|定稿|敲定|decided|chose|switch to/i,
];

export const PREFERENCE_SIGNALS: RegExp[] = [/更喜欢|偏好|倾向|prefer|约定|规范是|习惯/];

export const RULE_SIGNALS: RegExp[] = [
  /以后都要|以后必须|规则|不变量|invariant|所有容器|所有服务|所有系统/,
];

/**
 * **祈使式禁令** —— 用户直接下达的行为约束 (2026-09-18 新增)。
 *
 * 为什么必须单独一档: 判据此前只有"以后都要/以后必须/规则/不变量"这几个**名词式**信号,
 * 而真实对话里约束更常以**祈使句**给出。实测真库的丢弃样本 ──
 * "all 不要每次都在本桌面启动浏览器!"、"别接入写错了, 这是另一个项目" ──
 * 全部落进 `inferKind` 的 context 兜底, 而 context 一律丢弃。
 * 这类内容是"硬约束/偏好"里**最该记住**的一类: 它们是用户对助手行为的直接纠正,
 * 下次做同类任务时正是最需要的。丢掉它们等于让助手重复犯同一个错。
 *
 * 判据保守: 只认**句首或标点后**的祈使否定 (避免正文里的 "不要" 被误当约束, 例如
 * "那段代码不要了" 是在说某段代码, 不是在给助手下约束)。
 */
export const DIRECTIVE_PATTERNS: RegExp[] = [
  // 边界允许: 行首 / 空白 / 标点 (实测 "all 不要每次…" 的 "不要" 前是空格)。
  /(?:^|[ \t，,。；;！!？?\n])(?:不要|别|禁止|严禁|不用|无需|不准)[^ \t，,。；;！!？?\n]{2,}/,
  // 频次词强化: "别每次都…" / "不要总是…" (频次词说明它是长期约束而非一次性描述)
  /(?:^|[ \t，,。；;！!？?\n])(?:不要|别)(?:每次都|总是|一直|再)/,
  // 约定式统一: "统一用 X" / "一律 X" —— 这类表述本身就是"以后都这样"的意思
  /(?:统一|一律)(?:用|设|按|走|改|加|采用)/,
];

/** 用户在提问之后**自己敲定**了的信号 (采纳/确认/落地)。 */
export const CONCLUSION_SIGNALS: RegExp[] = [
  /就这样|就这么|就按这个|按你(说|推荐)的|敲定|成交|定稿/,
  /决定(?:采用|用|选|改|按)|选(?:定|用)了|定了/,
  /那就(?:用|按|选|走)[^。；;\n]{0,12}(?:吧|了)|用你(?:这|那)?个|按你(?:说|推荐)/,
  /以后再|下次(都)?要|从现在起/,
];

/**
 * "事情落地"类收束语: 它们**单独出现不足以证明"这事定了"**。
 *
 * 实测反例: "确实修好了"、"仅对住宅链路生效" —— 都收束在句末, 但可能是在描述别的东西。
 * 因此降级为"弱信号": 只有与"本轮有实质产出"共现时才作数 (见 `hasConclusionSignal`)。
 */
export const WEAK_CLOSURE_SIGNALS: RegExp[] = [
  /(?:修好|修复|跑通|通过|生效|完成|落地|提交)了?\s*[。！!~～]*$/,
];

/**
 * 推断这条文本该落成什么 kind。
 *
 * **顺序即优先级**, 逐条都有实测依据:
 *   1. 显式指令 (用户直接命令, 最高);
 *   2. **负面/纠正信号** (被骂的一轮常同时含决策词与指令词, 排后面就永远轮不到 ——
 *      实测真库 27 条辱骂原话落成了 decision);
 *   3. 跨轮约束 (规则/祈使禁令);
 *   4. 教训 → 决策 → 偏好 (由具体到泛);
 *   5. 兜底 context (调用方一般会丢弃它)。
 */
export function inferKind(text: string, negativity?: CaptureNegativity): MemoryKind {
  if (EXPLICIT_PATTERNS.some((p) => p.test(text))) return "fact";
  // ⚠ 负面/纠正信号**优先于其它一切信号** (2026-10-05, 用户实测)。
  //
  // 为什么必须排在最前: 被骂的那一轮往往同时含决策词与指令词 ("你他妈又错了, 应该先跑测试
  // 再改代码" 同时命中 LESSON/DECISION/纠错), 而旧代码把它落成 `decision` + **用户原话** ——
  // 真库实测 27 条辱骂原话就是这样进库的。这里改成落成 `lesson` (教训), 内容由 pipeline
  // 用 kernel/negativity 的 lessonDraftOf 换成"这次错在哪 + 该怎么做"。
  //
  // 为什么落 lesson 而不是 fact/decision: 它是**行为纠正**, 下次做同类任务时最需要 ——
  // 与 LESSON_SIGNALS 同族, 只是判据从"用户说了踩坑"扩到"用户在纠正我"。
  if (negativity?.detect(text).hit) return "lesson";
  if (RULE_SIGNALS.some((p) => p.test(text))) return "pattern";
  // 祈使式禁令也是"跨轮次仍成立"的约束, 与 RULE_SIGNALS 同类; 排在 lesson/decision 之前,
  // 因为"别 X"是约束而不是某次教训 (教训是"踩了坑之后总结", 约束是"直接下达的边界")。
  if (DIRECTIVE_PATTERNS.some((p) => p.test(text))) return "pattern";
  if (LESSON_SIGNALS.some((p) => p.test(text))) return "lesson";
  if (DECISION_SIGNALS.some((p) => p.test(text))) return "decision";
  if (PREFERENCE_SIGNALS.some((p) => p.test(text))) return "preference";
  return "context";
}
