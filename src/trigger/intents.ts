// trigger/intents.ts — 意图库: "什么样的提问算是在问历史" 的**唯一**事实源。
//
// 为什么从 policy.ts 拆出来: (1) policy.ts 已超仓库 400 行上限; (2) 变化原因不同 ——
// 本文件随"提问形状的认知"变 (要扩展意图、修误报), policy.ts 随"决策与预算策略"变。
// 拆开后意图库可以被单独审视、单独标定、单独测。
//
// 判定分两层 (实测标定, 详见 .agents/notes/implemented/feature/2026-09-11-intent-shape-vs-topic.md):
//   句式形状 (patterns) 命中即算; 裸话题词 (topicPatterns) 必须与提问形状**同分句**才算。
import { normalizeVoice } from "../kernel/voice.ts";
/**
 * 提问形状 (疑问/征询)。**只用于给"话题词"类模式加门槛**, 不用于形状类模式。
 *
 * 为什么要分开: 裸话题词 ("规范"/"偏好"/"踩过") 在**陈述句**里也大量出现 ——
 * 实测真实语料里"目录命名规范"这样列举规格的句子会被当成"在问约定"(误报),
 * 于是每轮多注入 300 token 无相关内容。而同一个词出现在问句里 ("命名规范是什么") 才是真信号。
 *
 * 门槛是**同分句**而不是同文本 —— 这一点是实测逼出来的:
 * 一条 300 字的消息里,"…目录命名规范…" (话题词) 与 "…如何开始训练…" (形状词)
 * 分处两个不相干的句子, 按"整段同现"判定仍然误报。同现 != 相关, 这是袋装正则的固有极限;
 * 收到**分句**以内是能廉价消除它的一步 (实测: 长文本误报被拦住, 而 8/8 真实回忆型提问不受影响)。
 */
const QUESTION_SHAPE = /(什么|怎么|如何|为什么|为啥|哪个|哪些|哪里|哪儿|多少|是否|有没有|能不能|可不可以|吗|呢|嘛|[?？])/;

/** 分句 (话题词与提问形状必须在同一句内才算数)。标点即句界, 中英标点都认。 */
function clausesOf(text: string): string[] {
  return text.split(/[。！？!?；;，,\n]|\.\s*/).filter((c) => c.trim().length > 0);
}

/**
 * 一种"回忆意图"。
 *
 * 两类模式**可靠性不同**, 因此分开声明 (实测标定, 见 .agents/notes 的触发层 Note):
 *   - patterns:     句式形状 (问过去/问依据/问约定) —— 句式本身就在表达"我在问", 直接命中;
 *   - topicPatterns: 裸话题词 (约定/偏好/踩过/坑) —— 必须**同时**有提问形状才算命中。
 * 合并成一类的后果 (修复前实测): 真实语料 63 条人类消息命中 11 条, 其中多数是
 * "目录命名规范"这类陈述句误报, 置信度还全部卡在下限 0.34 上, 阈值形同虚设。
 */
export interface TriggerIntent {
  id: string;
  /** 人类可读说明 (进触发日志, 便于解释为什么注入)。 */
  label: string;
  /** 句式模式: 命中即算 (句式本身已表达提问意图)。 */
  patterns: RegExp[];
  /** 话题词模式: 仅当文本同时具备提问形状时才算命中 (缺省无)。 */
  topicPatterns?: RegExp[];
}

/**
 * 默认意图库。**两层, 可靠性不同, 因此分开声明**:
 *   patterns      = 句式形状 ("为什么当初…" / "上游怎么解决的") —— 句式本身就在表达提问, 命中即算;
 *   topicPatterns = 裸话题词 ("规范" / "偏好" / "踩过") —— 必须**同时**有提问形状才算命中。
 *
 * 为什么必须分两层 (实测标定, 见 .agents/notes/implemented/feature/2026-09-11-intent-shape-vs-topic.md):
 * 合并成一类时, 真实语料 63 条人类消息命中 11 条, 其中多数是陈述句误报 ——
 * 例如"…目录命名规范…"只是**列举规格**, 却被当成"在问约定", 于是每轮多注入 300 token 无关内容。
 * 同一个词出现在问句里 ("命名规范是什么") 才是真信号: 词提供话题, 句形提供"我在问"。
 *
 * 加一条意图只需加一行; 命中率不足时优先扩这里, 而不是去扩裸关键词表
 * (裸词表是最容易退化成噪声的一类, 实测误报全部来自它)。
 */
export const DEFAULT_INTENTS: readonly TriggerIntent[] = [
  {
    id: "recall-decision",
    label: "回忆过去的决策与理由",
    patterns: [
      /为什么(我们|要|会|用|选|是)/,
      // "上次/之前/当时 + (怎么|如何|为什么|什么|解决|处理|做|定|选|用)" —— 中文追问的常见形状。
      /(之前|上次|上回|当时|当初|以前).{0,12}(怎么|如何|为什么|是什么|啥|解决|处理|做|定|选|用|说|提)/,
      /(why did we|why do we|what did we decide|how did we decide|what was the reasoning)/i,
      /(remember|recall) (when|how|what|the decision)/i,
    ],
    topicPatterns: [
      // "决定/结论/方案/取舍 + 是/什么" —— 前半是话题词, 后半是提问形状, 缺一不可。
      /(决定|结论|方案|取舍).{0,6}(是|是啥|什么|哪个)/,
      // "之前遇到过…吗": 回忆型经验的典型口语句形 (实测此形状此前被整条漏掉)。
      /(之前|以前|上次|曾经).{0,14}(遇到过|碰到过|见过|做过|处理过|踩过)/,
    ],
  },
  {
    id: "session-continuation",
    label: "接续上次的进度",
    patterns: [
      /(继续|接着|上次|前面|之前).{0,8}(做|干|到哪|进展|剩下|还没)/,
      /(我们|我).{0,4}(做到哪|进行到哪|还剩|下一步)/,
      /(where (were|did) we|what'?s left|pick up where|continue from)/i,
    ],
  },
  {
    id: "convention-preference",
    label: "询问约定、规范与偏好",
    patterns: [
      // 允许"我们这边一般怎么写"这类中间插入 (中文口语常把主语与副词拆开)。
      /(我们|这边|咱们).{0,6}(一般|通常|习惯|默认|约定).{0,8}(怎么|如何|用|写|做)/,
      /(how should i|right way)/i,
    ],
    topicPatterns: [
      // 裸词表: 只在问句里才算提问 ("命名规范是什么"), 陈述句里的"规范"不算。
      /(约定|规范|惯例|标准|风格|习惯|偏好)/,
      /(best practice|coding standard|convention|style guide)/i,
    ],
  },
  {
    id: "pitfall-avoidance",
    label: "避免重复踩坑",
    patterns: [
      // 祈使式的风险提醒本身就是信号 (用户在提醒 agent 别踩), 不是提问, 但同样指向历史经验。
      /(注意|小心|避免|别再|不要再).{0,10}(并发|超时|幂等|死锁|雪崩|泄漏)/,
    ],
    topicPatterns: [
      /(踩过|踩坑|坑|教训|翻过车|出过问题|踩雷)/,
      /(pitfall|gotcha|footgun|bit us|burned us)/i,
    ],
  },
  {
    id: "project-status",
    label: "询问项目状态与背景",
    patterns: [
      /(这个项目|本项目|我们项目).{0,8}(怎么|如何|是|用|背景|情况|状态)/,
      /(context|background|overview) (of|for) (this|the) (project|repo)/i,
    ],
    topicPatterns: [/(项目|仓库).{0,6}(现状|进展|状态|背景)/],
  },
  {
    id: "prior-art",
    label: "询问是否已有相关经验/既有做法",
    patterns: [
      /(有没有|是否|曾经).{0,8}(做过|写过|遇到过|处理过|试过)/,
      /(我们|之前).{0,6}(有没有|是否).{0,6}(类似|相关|一样的)/,
      /(have we|did we|is there) (ever|already|any).{0,12}(done|tried|seen|handled)/i,
    ],
  },
];
/**
 * 识别本轮文本命中的意图。返回命中数最多的那个 (可审计), 并给出置信度。
 *
 * 两层判定 (见 TriggerIntent 的说明):
 *   - 句式模式 (patterns) 命中即算;
 *   - 话题词模式 (topicPatterns) 只有**同时**具备提问形状 (QUESTION_SHAPE) 时才计入。
 * 这个门槛是实测必需的: 没有它时"目录命名规范"这类陈述句会被判成"在问约定"。
 */
export function detectIntent(
  rawText: string,
  intents: readonly TriggerIntent[] = DEFAULT_INTENTS,
): { intent: TriggerIntent; confidence: number; hits: number } | null {
  const text = normalizeVoice(rawText);
  if (!text.trim()) return null;
  // 话题词只在"含提问形状的那个分句"里才计入 (见 QUESTION_SHAPE 的说明)。
  const askingClauses = clausesOf(text).filter((c) => QUESTION_SHAPE.test(c));
  let best: { intent: TriggerIntent; hits: number } | null = null;
  for (const intent of intents) {
    let hits = intent.patterns.filter((p) => p.test(text)).length;
    if (intent.topicPatterns?.length && askingClauses.length) {
      for (const clause of askingClauses) {
        hits += intent.topicPatterns.filter((p) => p.test(clause)).length;
      }
    }
    if (hits === 0) continue;
    if (!best || hits > best.hits) best = { intent, hits };
  }
  if (!best) return null;
  // 置信度 = 1 - 0.5^命中数 (1 条 → 0.50, 2 条 → 0.75, 3 条 → 0.875)。
  //
  // 两个修正 (都由实测数据驱动, 见 Note):
  //   1. **不再除以模式总数**。旧公式 hits/patterns.length 让"给意图多补几条模式"反而
  //      降低同一份证据的置信度 —— 分母随覆盖度增长, 语义是反的。
  //   2. **去掉 0.34 下限**。旧下限恰好等于 minConfidence 默认值, 于是
  //      "置信度 >= 阈值"对任何命中都恒真 —— 实测 63 条真实消息命中 11 条, 11 条全部
  //      卡在 0.34 并全部通过门控, 置信度不携带任何信息、阈值也从未拦下过任何一条。
  //      现在 1 条即 0.50 (高于默认阈值, 单个句式命中确实是有意义的信号),
  //      而调用方可以把 minConfidence 抬到 0.7 来要求"至少两条独立模式"。
  const confidence = 1 - Math.pow(0.5, best.hits);
  return { intent: best.intent, confidence, hits: best.hits };
}
