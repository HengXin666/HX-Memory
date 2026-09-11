// trigger/policy.ts — 触发层: "AI 什么时候会去查记忆" 的确定性保证。
//
// 问题 (本模块存在的唯一理由):
//   模型**无法可靠地知道自己不知道什么**。让它在"需要时"调用 memory_search,
//   等于把"记忆是否生效"交给一次概率判断 —— 该搜时不搜 (幻觉自足), 不该搜时乱搜。
//   实测对照: 同一份记忆, 靠模型自觉的旧线 10 轮命中 6 轮; 代码判定的新线 10/10。
//
// 因此触发必须是**四种机制的组合**, 而不是单选:
//   1. always-on 保底: 跨项目规则 + 项目关键事实/偏好 —— 无条件注入 (受 token 预算约束)。
//      这是"模型完全没意识到要查"时的兜底, 也是唯一不依赖任何判定的通道。
//   2. intent 门控: 识别"回忆型提问" (问过去/为什么/上次/约定/踩过坑) → 命中即注入。
//      模式库可扩展, 且**不依赖项目是否声明过绑定** (没有任何绑定的新项目也能触发)。
//   3. drift 去重: 同一话题的连续轮次不重复注入 (省预算、避免噪声); 话题切换时强制重查。
//   4. 预算与可观测: 每次决策都给出 reason/confidence/budget, 落进触发日志 ——
//      "为什么没注入" 必须和 "注入了什么" 一样可查。
//
// 纯函数 + 可注入时钟, 无 IO (S1 可测)。
import type { MemoryEntry } from "../kernel/types.ts";
// 词集统一走 kernel/cjk 的权威实现: 此前这里另写了一份"只取 bigram"的版本,
// 与检索/去重的口径不一致 —— 同一对文本会在"话题漂移"与"去重裁决"里得出不同相似度。
import { tokenSet } from "../kernel/cjk.ts";
// 语音输入的错别字会让字面判定整体失效 (意图漏命中 / 同话题被误判成换话题), 因此先归一再判定。
import { normalizeVoice } from "../kernel/voice.ts";

/** 一种"回忆意图": 命中任意模式即认为本轮需要历史。 */
export interface TriggerIntent {
  id: string;
  /** 人类可读说明 (进触发日志, 便于解释为什么注入)。 */
  label: string;
  patterns: RegExp[];
}

/**
 * 默认意图库。设计原则: **匹配"提问的形状", 而不是匹配"知识的内容"** ——
 * 内容词永远列不全, 但"问过去/问依据/问约定"这些句式是有限且稳定的。
 * 加一条意图只需加一行; 命中率不足时优先扩这里, 而不是去扩关键词表。
 */
export const DEFAULT_INTENTS: readonly TriggerIntent[] = [
  {
    id: "recall-decision",
    label: "回忆过去的决策与理由",
    patterns: [
      /为什么(我们|要|会|用|选|是)/,
      // "上次/之前/当时 + (怎么|如何|为什么|什么|解决|处理|做|定|选|用)" —— 中文追问的常见形状。
      /(之前|上次|上回|当时|当初|以前).{0,12}(怎么|如何|为什么|是什么|啥|解决|处理|做|定|选|用|说|提)/,
      /(决定|结论|方案|取舍).{0,6}(是|是啥|什么|哪个)/,
      /(why did we|why do we|what did we decide|how did we decide|what was the reasoning)/i,
      /(remember|recall) (when|how|what|the decision)/i,
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
      /(约定|规范|惯例|标准|风格|习惯|偏好)/,
      // 允许"我们这边一般怎么写"这类中间插入 (中文口语常把主语与副词拆开)。
      /(我们|这边|咱们).{0,6}(一般|通常|习惯|默认|约定).{0,8}(怎么|如何|用|写|做)/,
      /(best practice|coding standard|convention|style guide|how should i|right way)/i,
    ],
  },
  {
    id: "pitfall-avoidance",
    label: "避免重复踩坑",
    patterns: [
      /(踩过|踩坑|坑|教训|翻过车|出过问题|踩雷)/,
      /(注意|小心|避免|别再|不要再).{0,10}(并发|超时|幂等|死锁|雪崩|泄漏)/,
      /(pitfall|gotcha|footgun|bit us|burned us)/i,
    ],
  },
  {
    id: "project-status",
    label: "询问项目状态与背景",
    patterns: [
      /(这个项目|本项目|我们项目).{0,8}(怎么|如何|是|用|背景|情况|状态)/,
      /(项目|仓库).{0,6}(现状|进展|状态|背景)/,
      /(context|background|overview) (of|for) (this|the) (project|repo)/i,
    ],
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

/** 触发决策 (可观测: 每次都要说清楚"注入了/没注入、为什么")。 */
export interface TriggerDecision {
  /** 是否应该做检索注入。 */
  inject: boolean;
  /** 命中的意图 (无则 null; always-on 通道不依赖意图)。 */
  intent: string | null;
  /** 0..1: 意图命中强度 (命中条数归一)。 */
  confidence: number;
  /** 0..1: 与上一轮查询的语义距离 (1 = 完全换话题)。 */
  topicDrift: number;
  /** 决策模式 (可审计)。 */
  mode: "always-on" | "intent" | "drift-refresh" | "skip-similar" | "skip-no-signal";
  /** 人可读理由 (进日志)。 */
  reason: string;
  /** 本轮建议的注入 token 预算。 */
  budgetTokens: number;
}

export interface TriggerPolicyOptions {
  intents?: readonly TriggerIntent[];
  /** 意图命中低于该置信度且无 always-on 内容时不注入 (默认 0.34, 即至少命中 1/3 的模式)。 */
  minConfidence?: number;
  /**
   * 话题漂移阈值 (默认 0.9, 由实测标定: 同话题含改述与长句追问 ≤0.8, 换话题 =1.0),
   * **一条线决定两件事**:
   *   drift >= 阈值 → 话题已切换, 强制重查;
   *   drift <  阈值 → 同一话题的连续追问, 若上一轮刚注入过则跳过。
   * 用两条线 (相似线 + 切换线) 会在中文短查询上出现"既不算相似也不算切换"的夹缝,
   * 实测 Jaccard 0.38 的同话题追问会掉进缝里 —— 所以只保留一条。
   */
  driftThreshold?: number;
  /** always-on 通道的 token 预算 (默认 400)。 */
  alwaysOnBudget?: number;
  /** 意图通道的 token 预算 (默认 300)。 */
  intentBudget?: number;
}

/**
 * 话题漂移 (0 = 同一话题, 1 = 完全不同)。无历史时返回 1 (视为话题切换)。
 *
 * 用**重叠系数** (|A∩B| / min(|A|,|B|)) 而不是 Jaccard: 连续追问往往很短
 * ("那这个下限呢"), 用 Jaccard 时 union 被撑大, 同话题的漂移会被高估到 0.6+
 * 与真正的换话题 (1.0) 挤在一起 —— 实测踩过。重叠系数只看"短的那侧有多少被覆盖",
 * 因此短追问不会因为自身短而被误判成换话题。
 */
/**
 * 指代型追问的标记。中文口语里 "那这个下限呢" / "它呢" 这类追问与上一轮**语义上**同话题,
 * 但字面上可能一个 token 都不重合 (实测 drift = 1.0, 会被误判成换话题)。
 * 这是纯字面度量的固有盲区, 因此显式补一条规则 —— 而不是去调阈值掩盖它。
 */
const ANAPHORIC_FOLLOWUP =
  /^(那|这|它|他|她|上面|刚才|还有|再|然后|所以|因此)|(这个|那个|上面说的|刚才说的|它的|他们的)/;

export function topicDriftOf(rawText: string, rawPrevious?: string): number {
  // 归一只用于**判定**: 漂移是"同一话题吗"的问题, 不该被一个语音错字推翻。
  const text = normalizeVoice(rawText);
  const previous = rawPrevious === undefined ? undefined : normalizeVoice(rawPrevious);
  const current = text.trim();
  if (!previous?.trim() || !current) return 1;
  // 短 + 指代 → 判定为延续上一话题 (保守: 只对很短的追问生效, 避免吞掉真正的新话题)。
  if (current.length <= 12 && ANAPHORIC_FOLLOWUP.test(current)) return 0;
  const a = tokenSet(text);
  const b = tokenSet(previous);
  if (!a.size || !b.size) return 1;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const overlap = inter / Math.min(a.size, b.size);
  return Math.max(0, Math.min(1, 1 - overlap));
}

/** 识别本轮文本命中的意图。返回命中数最多的那个 (可审计), 并给出归一化置信度。 */
export function detectIntent(
  rawText: string,
  intents: readonly TriggerIntent[] = DEFAULT_INTENTS,
): { intent: TriggerIntent; confidence: number; hits: number } | null {
  const text = normalizeVoice(rawText);
  if (!text.trim()) return null;
  let best: { intent: TriggerIntent; hits: number } | null = null;
  for (const intent of intents) {
    const hits = intent.patterns.filter((p) => p.test(text)).length;
    if (hits === 0) continue;
    if (!best || hits > best.hits) best = { intent, hits };
  }
  if (!best) return null;
  // 置信度: 命中条数 / 该意图的模式总数 (命中一半即 0.5), 至少 0.34。
  const confidence = Math.max(
    0.34,
    Math.min(1, best.hits / Math.max(1, best.intent.patterns.length)),
  );
  return { intent: best.intent, confidence, hits: best.hits };
}

export class TriggerPolicy {
  private readonly intents: readonly TriggerIntent[];
  private readonly minConfidence: number;
  private readonly driftThreshold: number;
  private readonly alwaysOnBudget: number;
  private readonly intentBudget: number;

  constructor(opts: TriggerPolicyOptions = {}) {
    this.intents = opts.intents ?? DEFAULT_INTENTS;
    this.minConfidence = opts.minConfidence ?? 0.34;
    this.driftThreshold = opts.driftThreshold ?? 0.9;
    this.alwaysOnBudget = opts.alwaysOnBudget ?? 400;
    this.intentBudget = opts.intentBudget ?? 300;
  }

  /**
   * 决定这一轮怎么注入。
   *
   * @param text          当前轮用户文本
   * @param hasAlwaysOn   是否有 always-on 内容 (跨项目规则/项目关键事实) —— 有则无条件注入
   * @param previousQuery 同一会话上一轮的查询 (用于话题漂移判定)
   * @param lastInjectedAt 上一次实际注入的时间 (ISO; 无则 null)
   */
  decide(input: {
    text: string;
    hasAlwaysOn: boolean;
    previousQuery?: string;
    lastInjectedAt?: string | null;
  }): TriggerDecision {
    const drift = topicDriftOf(input.text, input.previousQuery);
    const detected = detectIntent(input.text, this.intents);
    const confidence = detected?.confidence ?? 0;

    // 通道 1: always-on 保底 —— 不看意图, 无条件注入 (这是"模型没意识"时的唯一保证)。
    if (input.hasAlwaysOn) {
      // 但同一话题的连续追问不重复灌 (上一轮刚注入过且话题没变)。
      if (input.lastInjectedAt && drift < this.driftThreshold) {
        return {
          inject: false,
          intent: detected?.intent.id ?? null,
          confidence,
          topicDrift: drift,
          mode: "skip-similar",
          reason:
            "always-on 内容已在同一话题上一轮注入过 (drift=" +
            drift.toFixed(2) +
            "), 跳过重复注入以省预算",
          budgetTokens: 0,
        };
      }
      return {
        inject: true,
        intent: detected?.intent.id ?? null,
        confidence,
        topicDrift: drift,
        mode: "always-on",
        reason:
          "always-on 保底通道: 无条件注入跨项目规则/关键事实" +
          (detected ? " (本轮还命中意图 " + detected.intent.id + ")" : ""),
        budgetTokens: this.alwaysOnBudget + (detected ? this.intentBudget : 0),
      };
    }

    // 通道 2: 意图门控 —— 识别"回忆型提问", 不依赖项目是否声明过绑定。
    if (detected && confidence >= this.minConfidence) {
      return {
        inject: true,
        intent: detected.intent.id,
        confidence,
        topicDrift: drift,
        mode: "intent",
        reason:
          "命中回忆意图「" +
          detected.intent.label +
          "」(" +
          detected.hits +
          " 条模式, 置信度 " +
          confidence.toFixed(2) +
          ")",
        budgetTokens: this.intentBudget,
      };
    }

    // 通道 3: 话题切换 —— 上一轮注入过但本轮换了话题, 强制重查 (旧上下文可能已失效)。
    if (input.lastInjectedAt && drift >= this.driftThreshold) {
      return {
        inject: true,
        intent: detected?.intent.id ?? null,
        confidence,
        topicDrift: drift,
        mode: "drift-refresh",
        reason: "话题已切换 (drift=" + drift.toFixed(2) + "), 上一轮注入的内容不再适用, 强制重查",
        budgetTokens: this.intentBudget,
      };
    }

    return {
      inject: false,
      intent: detected?.intent.id ?? null,
      confidence,
      topicDrift: drift,
      mode: "skip-no-signal",
      reason: "无 always-on 内容、未命中回忆意图、话题也未切换 —— 不注入 (避免噪声)",
      budgetTokens: 0,
    };
  }

  /** 供工具侧复用: 一段文本是否值得让模型"想到去查" (用于 guidance/工具描述的共同口径)。 */
  isRecallShaped(text: string): boolean {
    return detectIntent(text, this.intents) !== null;
  }
}

/**
 * always-on 选择的入参。
 *
 * `ruleBudgetRatio` (2026-09): 规则组最多占预算的比例, 其余留给项目事实。
 * 为什么必须分仓: 修复前规则按 (score 100 + importance) 全排在前面, 6 条规则约 300 token
 * 会吃光 400 token 预算 —— 真正随任务变化的"架构决策/项目约定"一条都注入不进来 (实测确认)。
 * 规则是**不变量**, 但不该是**全部**。只在规则与其它两组都有候选时启用上限。
 */
export interface AlwaysOnOptions {
  project?: string;
  budgetTokens?: number;
  estimate: (text: string) => number;
  /** 规则组预算占比 (默认 0.6)。传 1 可恢复"规则优先填满"的旧行为。 */
  ruleBudgetRatio?: number;
}

/** 从条目里挑 always-on 内容: 已确认规则 + 项目关键事实/偏好 (受预算约束)。 */
export function selectAlwaysOn(
  entries: readonly MemoryEntry[],
  opts: AlwaysOnOptions,
): MemoryEntry[] {
  const budget = opts.budgetTokens ?? 400;
  const ratio = Math.min(1, Math.max(0, opts.ruleBudgetRatio ?? 0.6));
  const scored = entries
    .filter((e) => {
      if ((e.status ?? "active") !== "active") return false;
      if (e.kind === "rule") return e.scope === "global" && Boolean(e.confirmedBy && e.confirmedAt);
      // 非规则: 项目内关键事实/偏好/决策 (lesson 由意图通道按需召回, 不常驻)。
      // scope:"agent" 的关键事实/偏好是**跨工作区共享层**: 不属于任何项目, 对每个项目都常驻候选。
      if (e.scope === "agent") return e.kind === "fact" || e.kind === "preference";
      if (opts.project && e.scope === "project" && e.project !== opts.project) return false;
      return e.kind === "fact" || e.kind === "preference" || e.kind === "decision";
    })
    .map((e) => ({
      entry: e,
      // 规则优先级最高 (跨项目不变量), 其次偏好/决策, 最后事实; importance 作为微调。
      score:
        (e.kind === "rule" ? 100 : e.kind === "preference" ? 30 : e.kind === "decision" ? 20 : 10) +
        (e.importance ?? 5),
    }))
    .sort((a, b) => b.score - a.score);

  const rules = scored.filter((s) => s.entry.kind === "rule");
  const others = scored.filter((s) => s.entry.kind !== "rule");
  // 两组都有候选时才切分预算; 只有一组时用满, 不让分仓变成浪费。
  const ruleCap = rules.length > 0 && others.length > 0 ? Math.floor(budget * ratio) : budget;

  const out: MemoryEntry[] = [];
  const taken = new Set<string>();
  let used = 0;
  const fill = (group: typeof scored, cap: number): void => {
    for (const item of group) {
      if (taken.has(item.entry.id)) continue;
      const cost = opts.estimate(item.entry.content) + 8;
      if (used + cost > cap) continue;
      used += cost;
      taken.add(item.entry.id);
      out.push(item.entry);
    }
  };
  fill(rules, ruleCap);
  fill(others, budget);
  return out;
}
