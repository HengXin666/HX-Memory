// adapters/dsh/negativity-wiring.ts — 负面/纠正信号到宿主链路的接线。
//
// ## 这一层做三件事 (都不是"顺手加的")
//
//   1. **把设置里的词表变成可用的判定面** —— 词表是可配置的 (设置项), 而 engine/runtime 都不该
//      知道设置从哪来。这里做解析 + 编译 + 缓存 (编译有成本, 不能每条文本重来)。
//   2. **可选判官兜底** —— 词表确定但覆盖有限 (用户会换新词)。判官的语义判定能补上,
//      而它**只在词表未命中时**才被调用 (命中路径零开销)。
//   3. **命中即注入同类铁律** —— 用户实测的原话: "是不是别人都骂你了, 你为什么不记住这次的
//      教训"。只沉淀不注入等于那条教训要等下一次检索才可能被想起, 而被骂的**当下**正是最该
//      看见它的时刻。注入的是**已确认规则/本项目 lesson** 里与本次类别同族的那几条。
//
// ## 判官在这里的用法与 RecallGate 不同
//
// RecallGate 判"候选与输入是否相关"; 这里判"这句话是不是在批评/纠正我"。
// 两者都遵守同一条纪律: 判官**只能收紧, 不能放宽** —— 它说"是"才补上判定,
// 它报错/没把握/熔断时**退回纯词表行为** (词表命中的照常处置, 未命中的照常放过)。
// 因此判官不可用不会让这条链路消失, 只是少了兜底。
import type { DecisionPort } from "../../kernel/ports-decision.ts";
import { FallbackController } from "../decision/fallback.ts";
import type { DecisionLog } from "../decision/decision-log.ts";
import {
  compileNegativity,
  detectNegative,
  lessonDraftOf,
  mergeNegativityWords,
  parseNegativityWords,
  type CompiledNegativity,
  type NegativeSignal,
} from "../../kernel/negativity.ts";
import type { CaptureNegativity } from "../../capture/engine.ts";

/** 判定用途 (写进决策账本; 一个账本里有多种判定, 必须能切开看)。 */
export const NEGATIVITY_PURPOSE = "negativity-gate";

export interface NegativityWiringDeps {
  /** 读当前设置里的词表原文 (每次求值: 面板改动当轮生效)。 */
  words: () => string;
  /** 是否启用判官兜底 (每次求值)。 */
  judgeEnabled: () => boolean;
  /** 判官实现 (可选; 不传 = 永远只用词表)。 */
  port?: DecisionPort;
  /** 熔断控制器 (可选; 与 RecallGate 分开, 因为两者的容忍度不同)。 */
  fallback?: FallbackController;
  /** 决策账本 (可选)。 */
  log?: DecisionLog;
  /**
   * 查"以往同类纠正" (由组装根注入 —— 检索面在 Facade, 而本模块不该依赖它)。
   *
   * 缺省不传 = 只出"当下提示"不出历史 (提示本身仍有效, 只是少了"以前也这样被说过")。
   */
  recallLessons?: (text: string) => Promise<readonly string[]>;
}

/** 接线结果: 给 runtime 的判定面 + 给面板的可观测面。 */
export interface NegativityWiring {
  /** 注入给 capture 链路的判定面 (含判官的**异步**路径; detect 是同步的纯词表路径)。 */
  capture: CaptureNegativity;
  /** 词表编译结果与解析错误 (面板要能显示"我配的那行没生效")。 */
  status(): {
    words: number;
    invalid: readonly string[];
    error?: string;
    judgeEnabled: boolean;
    judgeAvailable: boolean;
  };
  /** 判官兜底 (async; 词表未命中时才值得调)。返回 null = 没判定 (未启用/不可用/熔断)。 */
  judge(text: string): Promise<NegativeSignal | null>;
  /**
   * **命中即注入同类铁律** (用户实测诉求: "是不是别人都骂你了, 你为什么不记住这次的教训")。
   *
   * 只沉淀不注入 = 那条教训要等下一次检索才可能被想起; 而被骂的**当下**正是最该看见它的时刻。
   * 未命中时**同步返回 undefined** (零开销 —— 这是每轮都跑的路径)。
   */
  hint(text: string): Promise<string | undefined>;
}

/**
 * 装配负面信号链路。
 *
 * 词表编译**按内容变化缓存**: 面板改一次词表只重编一次, 而每条文本的判定仍走缓存的那份。
 * 判据是"原文变了才重编" (不是"每次求值都重编") —— 后者会在每轮捕获上白付一次编译成本。
 */
export function wireNegativity(deps: NegativityWiringDeps): NegativityWiring {
  let cachedSource = "\u0000";
  let cached: CompiledNegativity = compileNegativity();
  let parseError: string | undefined;

  /** 取当前编译结果 (原文变化才重编)。 */
  const compiled = (): CompiledNegativity => {
    const raw = deps.words() ?? "";
    if (raw === cachedSource) return cached;
    cachedSource = raw;
    if (!raw.trim()) {
      // 未配置 = 用缺省词表 (不是"什么都不判")。
      parseError = undefined;
      cached = compileNegativity();
      return cached;
    }
    const parsed = parseNegativityWords(raw);
    if (parsed.error) {
      // 格式错误: **保留缺省词表并记下错误** —— 一个格式手滑不该让整条链路停摆
      // (那也是本仓"坏输入不许静默"的一贯处置: 错要能看见, 但别把功能一起关掉)。
      parseError = parsed.error;
      cached = compileNegativity();
      return cached;
    }
    parseError = undefined;
    cached = compileNegativity(mergeNegativityWords(parsed.words));
    return cached;
  };

  const capture: CaptureNegativity = {
    detect: (text: string) => detectNegative(text, compiled()),
    lessonDraft: (signal: NegativeSignal, text: string) => lessonDraftOf(signal, text, compiled()),
  };

  return {
    capture,
    status: () => ({
      words: compiled().entries.length,
      invalid: compiled().invalid,
      ...(parseError ? { error: parseError } : {}),
      judgeEnabled: deps.judgeEnabled(),
      // `available` 是 JEV 实现的**扩展**能力 (不在 DecisionPort 契约里): 用结构探测读它,
      // 读不到就按"有实现即可用"处理 (doctor() 才是契约内的可用性自检)。
      judgeAvailable: Boolean(
        (deps.port as { available?: () => boolean } | undefined)?.available?.() ?? deps.port,
      ),
    }),
    judge: async (text: string) => await judgeFallback(deps, text),
    hint: async (text: string) => {
      const signal = capture.detect(text);
      if (!signal.hit) return undefined;
      // ⚠ **措辞主语是我, 不是用户** (2026-10-05, 用户实测否决了"用户对XX不满"那种写法):
      // 提示的读者是**即将回复的那一轮的我**, 而我要的是"现在该怎么做", 不是"对方是什么情绪"。
      // 因此这里也统一成行为约束的口气, 与落库的 lesson 模板同源 (禁止X / 改为Y)。
      //
      // 这是"当下提示", **不进记忆** —— 它的内容是别的轮次的教训 + 本轮的即时要求,
      // 不是这一轮的沉淀物 (沉淀物由 pipeline 走 lesson 路径)。
      const where = signal.kinds.includes("blame-execution")
        ? "在失败路径上反复硬试"
        : signal.kinds.includes("blame-method")
          ? "未经确认就开工"
          : "按自己的理解直接开干";
      const lines = await (deps.recallLessons?.(text) ?? Promise.resolve([]));
      const tail = lines.length
        ? "\n以往同类约束 (照它做):\n" + lines.map((l) => "- " + l).join("\n")
        : "";
      return (
        "【本轮挨批了 —— 先停下, 别辩解】" +
        "正在被否决的写法: " +
        where +
        "。立刻改为: 先复述你理解到的方向并确认, 再动手; 不要重述已完成的部分。" +
        tail
      );
    },
  };
}

/**
 * 判官兜底: 只回答"这句话是不是在批评/纠正我"。
 *
 * 纪律与 RecallGate 一致 (见该文件头注):
 *   · 未启用/无实现 → 返回 null (调用方退回纯词表行为, **不是**"不处置");
 *   · 熔断中 → 连判官都不调;
 *   · 判官说"是" → 返回一条信号 (kind 由判官给的类别决定, 缺失则按 correction 处理);
 *   · 判官说"否"/报错 → 返回 null (词表没命中就是没命中, 这一步只做**补充**)。
 *
 * state 写法遵守 PORT.md 纪律 1 (给症状与事实, 不给结论)。
 */
async function judgeFallback(
  deps: NegativityWiringDeps,
  text: string,
): Promise<NegativeSignal | null> {
  if (!deps.judgeEnabled() || !deps.port) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  const fallback = deps.fallback;
  if (fallback?.circuitOpen()) return null;
  const started = Date.now();
  const instructions =
    "判断这句话的内容: 说话人是在**批评或纠正对方** (对方案/做法的否定, 对执行过程的不满, " +
    "或明确指出对方理解错了), 还是在**正常地提出新任务/提问/陈述**?" +
    "只要语义上是在表达不满或纠正, 即使没有脏话也选 yes。";
  let outcome;
  try {
    outcome = await deps.port.decide(
      "场景: 一个 AI 助手的用户发来了下面这句话。\n用户原文: " + trimmed.slice(0, 600),
      [
        {
          qid: "negative",
          type: "choice",
          instructions,
          criteria: {
            yes: "在批评/纠正 (针对做法、执行过程或理解)",
            no: "正常提需求、提问或陈述, 没有负面指向",
          },
        },
      ],
      deps.port.capabilities().needsVoting ? 7 : 1,
    );
  } catch {
    // 判官异常 = 没有兜底, 不是"没有负面" (退回 null 由调用方按词表结果处置)。
    return null;
  }
  const route = fallback?.route(outcome) ?? { usePrimary: outcome.ok };
  if (!route.usePrimary || outcome.answers["negative"]?.choice !== "yes") {
    deps.log?.append({
      purpose: NEGATIVITY_PURPOSE,
      adapter: deps.port.name,
      outcome: outcome.ok ? "upgraded" : "error",
      ...(outcome.agreement === undefined ? {} : { agreement: outcome.agreement }),
      reason: outcome.ok ? "判官未判定为负面 (退回词表结果)" : "判官不可用: " + outcome.error,
      elapsedMs: Date.now() - started,
    });
    return null;
  }
  deps.log?.append({
    purpose: NEGATIVITY_PURPOSE,
    adapter: deps.port.name,
    outcome: "used",
    agreement: outcome.agreement,
    choice: "yes",
    reason: "判官判定用户在批评/纠正 (词表未覆盖, 由语义兜底补上)",
    elapsedMs: Date.now() - started,
  });
  // 判官只说"是负面", 分不出是方法错还是执行不满 —— **不猜**: 归入 correction
  // (它的处置最保守: 只落"用户纠正"类草稿, 不做"重看这一轮"的推断)。
  return {
    hit: true,
    kinds: ["correction"],
    hits: [{ kind: "correction", matched: "judge" }],
    level: 1,
    reason: "判官兜底: 语义判定为批评/纠正 (词表未命中)",
  };
}
