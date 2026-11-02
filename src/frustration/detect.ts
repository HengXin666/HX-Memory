// src/frustration/detect.ts — 挫折检测: 技术词豁免 + 线性打分器 (不调用模型); 判官只做旁路 (PLAN.md J3.1, EVAL.md A1/A2)。
//
// 这是挫折链路唯一的检测入口。此前有三处各自判定 (prestep 每个 step 重判、capture 轮末再判、external/policy.ts),
// 词表口径还不一样。这里统一成一份: 先把技术词所在的片段遮掉, 再抽特征打分。
//
// 2026-11-01 改动 (用户要求「不占模型额度、可观测、可复现」):
//   · 判定 = features.ts 抽特征 × model.ts 里的权重, score >= threshold 即命中; 不调用任何模型;
//   · model.ts 由 scripts/eval/train-frustration.ts 从标注样本选型、训练后生成 (选型依据见 FRUSTRATION-MODEL.md);
//   · 每次判定返回 score / threshold / contributions, 误报漏报能直接看到是哪条特征、几分;
//   · 判官降级为旁路 (shadowJudge): 默认不启用; 启用时在后台跑, 结论只通过 onShadow 记一笔「打分器 vs 判官」是否一致,
//     **永远不改变判定结果**。旧的 judge 选项等同 shadowJudge (不再能补判「是」)。
import {
  compileNegativity,
  detectNegative,
  type CompiledNegativity,
  type NegativeKind,
} from "../kernel/negativity.ts";
import { maskTechTerms, TECH_TERMS } from "./detect-mask.ts";
import { explain, type LinearModel } from "./classifier.ts";
import { extractPosteriorFeatures } from "./features.ts";
import { MODEL } from "./model.ts";

export { maskTechTerms, TECH_TERMS };

export interface FrustrationSignal {
  hit: boolean;
  /** 命中来源: model = 线性打分器, posterior = 轮末补偿 (compensateAtTurnEnd, 只在助手回完之后), none = 未命中。(judge 已降级为旁路, 不再出现在这里。) */
  via: "model" | "none" | "posterior" | "lexicon-floor";
  kinds: NegativeKind[];
  /** 命中的词表片段, 加上贡献为正的规则特征名 (cue:*)。 */
  matched: string[];
  /** 被技术词豁免挡掉的片段 (可观测: 误报分析看它)。 */
  exempted: string[];
  /** 打分 (可观测)。未命中时也给出, 便于看离阈值多远。 */
  score?: number;
  threshold?: number;
  /** 非零贡献的特征, 按 |权重| 从大到小, 最多 8 个。 */
  contributions?: Array<{ feature: string; weight: number }>;
  /** 模型标识: <version>/<候选>/<样本哈希>。 */
  model?: string;
}

export const NO_FRUSTRATION: FrustrationSignal = {
  hit: false,
  via: "none",
  kinds: [],
  matched: [],
  exempted: [],
};

/** 判官: 返回 true = 在骂或在纠正; false = 不是; null = 没判 (未启用、报错、熔断)。只作旁路。 */
export type FrustrationJudge = (text: string, prevAssistant: string) => Promise<boolean | null>;

/** 旁路记录: 打分器结论与判官结论。只用于观测 (分歧样本可以拿去补标注), 不影响判定。 */
export interface ShadowRecord {
  text: string;
  model: boolean;
  judge: boolean | null;
  agree: boolean | null;
  score: number | undefined;
}

export interface FrustrationDetector {
  /** 同步判定 (技术词豁免 + 打分器)。 */
  detect(text: string, prevAssistant?: string): FrustrationSignal;
  /** 与 detect 结果相同; 若配了旁路判官, 另在后台跑判官并回调 onShadow。保留这个名字是为了不改 pipeline 的调用点。 */
  detectWithJudge(text: string, prevAssistant?: string): Promise<FrustrationSignal>;
}

/** 词表口径的模型: 任一类词表命中即判是。用于没有训练模型时, 与旧的纯词表判定等价。 */
export const LEXICON_MODEL: LinearModel = {
  version: "linear-1",
  groups: { lex: true, cue: false, shape: false, ngram: false },
  bias: 0,
  threshold: 1,
  weights: { "lex:blame-method": 1, "lex:blame-execution": 1, "lex:correction": 1 },
  meta: { candidate: "A", note: "lexicon equivalent" },
};

export function createDetector(opts: {
  compiled?: () => CompiledNegativity;
  /** 旁路判官 (默认无)。 */
  shadowJudge?: FrustrationJudge;
  /** @deprecated 等同 shadowJudge: 判官不再能改判定。 */
  judge?: FrustrationJudge;
  onShadow?: (r: ShadowRecord) => void;
  techTerms?: readonly string[];
  model?: LinearModel;
} = {}): FrustrationDetector {
  const fallback = compileNegativity();
  const compiled = opts.compiled ?? (() => fallback);
  const model = opts.model ?? MODEL;
  const modelId = [model.version, String(model.meta.candidate ?? "?"), String(model.meta.samplesSha256 ?? "-")].join("/");
  const shadow = opts.shadowJudge ?? opts.judge;
  const detect = (text: string, prevAssistant = ""): FrustrationSignal => {
    const { masked, exempted } = maskTechTerms(text, opts.techTerms);
    const c = compiled();
    const ex = explain(model, text, prevAssistant, c);
    const lex = detectNegative(masked, c);
    const base = { score: ex.score, threshold: ex.threshold, contributions: ex.contributions.slice(0, 8), model: modelId };
    if (!ex.hit) return { ...NO_FRUSTRATION, exempted, ...base };
    const cues = ex.contributions.filter((x) => x.weight > 0 && x.feature.startsWith("cue:")).map((x) => x.feature);
    return {
      hit: true,
      via: ex.via ?? "model",
      kinds: lex.kinds.length ? lex.kinds : ["correction"],
      matched: [...lex.hits.map((h) => h.matched.trim()).filter(Boolean), ...cues],
      exempted,
      ...base,
    };
  };
  return {
    detect,
    async detectWithJudge(text, prevAssistant = "") {
      const signal = detect(text, prevAssistant);
      if (shadow && text.trim()) {
        void Promise.resolve()
          .then(() => shadow(text, prevAssistant))
          .catch(() => null)
          .then((verdict) => {
            const judge = typeof verdict === "boolean" ? verdict : null;
            opts.onShadow?.({ text, model: signal.hit, judge, agree: judge === null ? null : judge === signal.hit, score: signal.score });
          })
          .catch(() => undefined);
      }
      return signal;
    },
  };
}

/**
 * 轮末补偿判定 (后验路径, 不是实时检测)。
 *
 * 时序: 用户消息到达时只跑 detect() (实时路, 只看用户原话和上一条助手消息)。助手这一轮回完之后, 调用方拿到
 * 助手回复首句, 再调这里: 实时路已判「是」的原样返回 (不重复记录, 见 EVAL A3); 实时路判「否」、但首句命中后验特征
 * (POSTERIOR_CUES, 目前只有 cue:apology-opener) 时, 返回 hit=true, via="posterior", 由调用方回补一条纠正记录。
 *
 * 加分规则: 后验特征的分值 = threshold - bias, 即单凭它就过阈值。没有用逻辑回归学这个权重, 因为依据只有 10 条首句
 * (阳性 9 / 阴性 1), 学出来的权重没有意义; 等价于「实时命中 OR 首句以你说得对开头」。
 * 禁止把这个函数或后验特征接进 detect()/detectWithJudge(): 那等于用未来信息判定当前消息, 是逻辑错误。
 */
export function compensateAtTurnEnd(
  realtime: FrustrationSignal,
  nextAssistantFirst: string,
  model: LinearModel = MODEL,
): FrustrationSignal & { compensated: boolean } {
  if (realtime.hit) return { ...realtime, compensated: false };
  const post = [...extractPosteriorFeatures(nextAssistantFirst).keys()];
  if (!post.length) return { ...realtime, compensated: false };
  // 语义是「实时命中 OR 首句命中后验特征」(与 train-frustration.ts 的后验口径一致)。
  // 2026-11-01 修: 旧实现是 realtime.score + (threshold - bias), 实时分很低时 (如「我操, 又坏了」-1.25) 加完仍过不了阈值, 与 OR 口径不符。
  const bonus = model.threshold - model.bias;
  const score = Math.max(realtime.score ?? model.bias, model.threshold);
  return {
    ...realtime,
    hit: true,
    via: "posterior" as FrustrationSignal["via"],
    kinds: realtime.kinds.length ? realtime.kinds : ["correction"],
    matched: [...realtime.matched, ...post],
    score,
    contributions: [...post.map((feature) => ({ feature, weight: bonus })), ...(realtime.contributions ?? [])].slice(0, 8),
    compensated: true,
  };
}
