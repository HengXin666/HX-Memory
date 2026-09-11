// kernel/feedback.ts — 召回质量的**负面**标注 (纯逻辑, 无 IO)。
//
// 放在 kernel 而不是 app: 这些是"什么算坏标注"的规则本身 (数据模型层),
// 判定与阈值必须与存储/宿主无关, 才能被单测直接钉住 (见 tests/s1/feedback.test.ts)。
//
// 三条不可动摇的性质:
//   1. **只记坏的**。没有 used/good 之类的正向计数 —— 好的不记, 沉默是默认且期望的状态。
//      逼 agent 逐条表态会造成义务感, 它会为交差而编造评价, 而噪声比没有信号更糟。
//   2. **两类分开**。irrelevant (召回了但不相关 → 检索/排序问题) 与
//      wrong (内容不符/过时 → 内容问题, 需人审) 修法完全不同, 合成一个分数会丢掉指向。
//   3. **样本少必须向中性收缩**。曝光 1 次就错 1 次时, 不能把条目一棒打死 ——
//      分母太小, 单次标注没有统计意义。
import type { RecallFeedback } from "./types.ts";

/** 空标注 (等价于"没有坏反馈")。 */
export const NO_FEEDBACK: RecallFeedback = { irrelevant: 0, wrong: 0 };

/** 归一: 负数/非有限值归零并向下取整 (坏值不能让整条记忆解析失败)。 */
export function normalizeFeedback(input: unknown): RecallFeedback | undefined {
  if (input === undefined || input === null || typeof input !== "object") return undefined;
  const raw = input as { irrelevant?: unknown; wrong?: unknown };
  const irrelevant = countOf(raw.irrelevant);
  const wrong = countOf(raw.wrong);
  if (irrelevant === 0 && wrong === 0) return undefined;
  return { irrelevant, wrong };
}

function countOf(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

/** 坏标注总数 (分子)。 */
export function badCount(feedback: RecallFeedback | undefined): number {
  if (!feedback) return 0;
  return (feedback.irrelevant ?? 0) + (feedback.wrong ?? 0);
}

/**
 * 质量因子 0..1: `1 - bad/(bad+exposure)`, 其中 exposure 是曝光次数 (reinforcement)。
 *
 * 为什么用这个形状:
 *   - **分母用曝光**: reinforcement 恰好准确度量了"被展示过几次"(带 60s 合并窗口),
 *     它的问题是被误用成质量分; 在这里它是正确的分母。
 *   - **向中性收缩**: 曝光少时因子贴近 1 (不惩罚), 样本够了坏评才显出威力。
 *     exposure=0 的条目**完全不受影响** (从未展示过就谈不上质量)。
 *   - 下限 0.2: 即使坏评压倒性, 也只降权不消失 —— 丢弃是治理动作, 不是排序动作。
 */
export function qualityFactor(feedback: RecallFeedback | undefined, exposure: number): number {
  const bad = badCount(feedback);
  if (bad === 0) return 1;
  const shown = Math.max(0, Math.floor(exposure));
  if (shown === 0) return 1;
  // 贝叶斯平滑 (先验坏评率 + 伪计数), 使小样本向中性收缩:
  //   ratio = (bad + α·PRIOR) / (shown + α)
  // 分母**只能用曝光次数**。我第一版写成 bad+shown 是错的 —— 它把分子重复计进分母,
  // 于是"全错"时 ratio 也只能趋近 0.5, 因子永远降不到 0.5 以下。
  const ALPHA = 4;
  const PRIOR_BAD_RATE = 0.2;
  const ratio = (bad + ALPHA * PRIOR_BAD_RATE) / (shown + ALPHA);
  const factor = 1 - ratio;
  return Math.min(1, Math.max(0.2, factor));
}

/** 触发人审的阈值: 曝光够多**且**坏评占比够高 (两个条件必须同时满足)。 */
export const REVIEW_MIN_EXPOSURE = 5;
export const REVIEW_MIN_RATIO = 0.5;

/**
 * 是否该为这条记忆产出"改写/废弃"的人审提议。
 * 用比例而非绝对次数: 绝对次数会在"只曝光 2 次就错 2 次"时过早触发;
 * 比例自带最小样本量约束 (配合 REVIEW_MIN_EXPOSURE)。
 */
export function needsReview(feedback: RecallFeedback | undefined, exposure: number): boolean {
  const bad = badCount(feedback);
  if (bad === 0) return false;
  const shown = Math.max(0, Math.floor(exposure));
  if (shown < REVIEW_MIN_EXPOSURE) return false;
  return bad / shown >= REVIEW_MIN_RATIO;
}
