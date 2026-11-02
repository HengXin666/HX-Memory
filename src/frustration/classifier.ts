// src/frustration/classifier.ts — 线性打分器: 训练、交叉验证、打分、解释 (纯函数, 无依赖, 无随机)。
//
// 判定: score = bias + Σ weight[f] · x[f]; score >= threshold 判为挫折 (骂人或纠正)。
// 每次判定都能给出贡献最大的特征 (explain), 这是「可观测」的落点: 误报/漏报能直接看到是哪条规则、几分。
//
// 训练: L2 正则的逻辑回归, 全批量梯度下降, 固定步数, 权重初值全 0, 正负样本按频率反比加权。
// 同一份样本 + 同一组超参 ⇒ 逐位相同的权重 (只用 + × exp, 迭代顺序固定)。
// 阈值: 在训练集上取「误报率 <= 目标值」时最低的阈值 (EVAL A2 <= 0.05)。
import type { CompiledNegativity } from "../kernel/negativity.ts";
import { extractFeatures, fnv1a, type FeatureGroups, type FeatureVector } from "./features.ts";

export interface LinearModel {
  version: string;
  groups: FeatureGroups;
  bias: number;
  threshold: number;
  weights: Record<string, number>;
  /**
   * 词表兜底 (2026-11-01): true 时任一 lex:blame-method / lex:blame-execution / lex:correction 命中即判是, 不看分数。
   * 来由: B 学出的 lex 权重 (+0.58) 加 bias 过不了阈值, 「不对」「错了」这类 A 能判中的短纠正在 B 下全漏。
   * 兜底保证「A 判中的, 换模型后仍判中」; 是否采用由选型 (train-frustration.ts 候选 E) 按同一 bootstrap 规则决定。
   */
  lexiconFloor?: boolean;
  /** 训练元信息: 样本哈希、条数、超参; 用来核对「这个模型是哪份数据训出来的」。 */
  meta: Record<string, unknown>;
}

export interface TrainSample {
  id: string;
  group: string;
  text: string;
  y: 0 | 1;
  prevAssistant?: string;
  /** 下一条助手消息首句。只给后验口径 (离线评测 / 轮末补偿) 用; fit / crossValidate / extractFeatures 都不读它。 */
  nextAssistantFirst?: string;
}

export interface TrainOptions {
  groups: FeatureGroups;
  l2: number;
  steps: number;
  lr: number;
  targetFpr: number;
}

export const DEFAULT_TRAIN: Omit<TrainOptions, "groups"> = { l2: 0.01, steps: 600, lr: 0.5, targetFpr: 0.05 };

export function scoreVector(m: Pick<LinearModel, "bias" | "weights">, x: FeatureVector): number {
  let s = m.bias;
  for (const [k, v] of x) s += (m.weights[k] ?? 0) * v;
  return s;
}

export interface Explained {
  hit: boolean;
  score: number;
  threshold: number;
  /** 非零贡献的特征, 按 |贡献| 从大到小。 */
  contributions: Array<{ feature: string; weight: number }>;
  /** 只有分数没过阈值、靠词表兜底判是时才有。 */
  via?: "lexicon-floor";
}

export function explain(m: LinearModel, text: string, prevAssistant = "", compiled?: CompiledNegativity): Explained {
  const x = extractFeatures(text, m.groups, { prevAssistant, compiled });
  const score = scoreVector(m, x);
  const contributions = [...x.keys()]
    .map((feature) => ({ feature, weight: m.weights[feature] ?? 0 }))
    .filter((c) => c.weight !== 0)
    .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight) || a.feature.localeCompare(b.feature));
  const floorHit = !!m.lexiconFloor && LEXICON_FLOOR_FEATURES.some((k) => x.has(k));
  return { hit: score >= m.threshold || floorHit, score, threshold: m.threshold, contributions, ...(floorHit && score < m.threshold ? { via: "lexicon-floor" as const } : {}) };
}

/** 词表兜底看的特征, 与 detect.ts 的 LEXICON_MODEL 权重键一致。 */
export const LEXICON_FLOOR_FEATURES = ["lex:blame-method", "lex:blame-execution", "lex:correction"] as const;

const sigmoid = (z: number) => (z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z)));

/** 在给定样本上训练。返回的模型阈值按 targetFpr 在训练集上选。 */
export function fit(samples: readonly TrainSample[], o: TrainOptions): LinearModel {
  const xs = samples.map((s) => extractFeatures(s.text, o.groups, { prevAssistant: s.prevAssistant }));
  const keys = [...new Set(xs.flatMap((x) => [...x.keys()]))].sort();
  const idx = new Map(keys.map((k, i) => [k, i]));
  const rows = xs.map((x) => [...x].map(([k, v]) => [idx.get(k)!, v] as const));
  const nPos = samples.filter((s) => s.y === 1).length;
  const nNeg = samples.length - nPos;
  const wPos = nPos ? samples.length / (2 * nPos) : 0;
  const wNeg = nNeg ? samples.length / (2 * nNeg) : 0;
  const w = new Float64Array(keys.length);
  let b = 0;
  const n = samples.length || 1;
  for (let step = 0; step < o.steps; step++) {
    const g = new Float64Array(keys.length);
    let gb = 0;
    for (let i = 0; i < rows.length; i++) {
      let z = b;
      for (const [j, v] of rows[i]!) z += w[j]! * v;
      const cw = samples[i]!.y === 1 ? wPos : wNeg;
      const err = (sigmoid(z) - samples[i]!.y) * cw;
      gb += err;
      for (const [j, v] of rows[i]!) g[j]! += err * v;
    }
    for (let j = 0; j < w.length; j++) w[j] = w[j]! - o.lr * (g[j]! / n + o.l2 * w[j]!);
    b -= o.lr * (gb / n);
  }
  const weights: Record<string, number> = {};
  keys.forEach((k, j) => {
    const v = Math.round(w[j]! * 1e4) / 1e4;
    if (v !== 0) weights[k] = v;
  });
  const model: LinearModel = {
    version: "linear-1",
    groups: o.groups,
    bias: Math.round(b * 1e4) / 1e4,
    threshold: 0,
    weights,
    meta: { n: samples.length, nPos, l2: o.l2, steps: o.steps, lr: o.lr, targetFpr: o.targetFpr },
  };
  model.threshold = pickThreshold(
    xs.map((x, i) => ({ s: scoreVector(model, x), y: samples[i]!.y })),
    o.targetFpr,
  );
  return model;
}

/**
 * 最低的阈值, 使训练集误报率 <= targetFpr。候选阈值取负样本得分 (阈值放在某个负样本得分之上一点)。
 * 负样本为 0 时返回 0。
 */
export function pickThreshold(scored: ReadonlyArray<{ s: number; y: 0 | 1 }>, targetFpr: number): number {
  const neg = scored.filter((r) => r.y === 0).map((r) => r.s).sort((a, b) => b - a);
  if (!neg.length) return 0;
  const allowed = Math.floor(targetFpr * neg.length); // 允许误报的条数
  // 第 allowed 个最高的负样本得分之上: 只有前 allowed 个负样本 >= 阈值
  const cut = neg[allowed]!;
  return Math.round((cut + 1e-6) * 1e6) / 1e6;
}

export interface Prediction {
  id: string;
  group: string;
  y: 0 | 1;
  hit: boolean;
  score: number;
  threshold: number;
  fold: string;
}

/** 把会话确定性地分进 k 折: 按会话名的 FNV 哈希排序后轮流分配 (与样本顺序无关)。 */
export function assignFolds(groups: readonly string[], k: number, salt = ""): Map<string, number> {
  const uniq = [...new Set(groups)].sort((a, b) => fnv1a(salt + a) - fnv1a(salt + b) || a.localeCompare(b));
  return new Map(uniq.map((g, i) => [g, i % k]));
}

/** 只用 `train` 自己的折外得分选阈值 (内层分组 CV), 避免「训练集上可分 ⇒ 阈值过低」。 */
export function fitWithHonestThreshold(train: readonly TrainSample[], o: TrainOptions, innerK: number): LinearModel {
  const m = fit(train, o);
  const folds = assignFolds(train.map((s) => s.group), innerK);
  const scored: Array<{ s: number; y: 0 | 1 }> = [];
  for (let f = 0; f < innerK; f++) {
    const tr = train.filter((s) => folds.get(s.group) !== f);
    const te = train.filter((s) => folds.get(s.group) === f);
    if (!te.length || !tr.some((s) => s.y === 1) || !tr.some((s) => s.y === 0)) continue;
    const mi = fit(tr, o);
    for (const s of te) scored.push({ s: scoreVector(mi, extractFeatures(s.text, o.groups, { prevAssistant: s.prevAssistant })), y: s.y });
  }
  if (scored.some((r) => r.y === 0)) m.threshold = pickThreshold(scored, o.targetFpr);
  m.meta = { ...m.meta, thresholdFrom: `inner ${innerK}-fold grouped CV` };
  return m;
}

/**
 * 嵌套分组交叉验证 (一组 = 一个会话)。外层 k 折: 每折在其余会话上训练, 阈值由内层分组 CV 的折外得分选,
 * 只对留出的会话打分。用会话分组, 是因为同一会话里的消息措辞高度相关, 按条随机切会高估;
 * 阈值必须用折外得分选, 否则高维特征 (n 元组) 在训练集上完全可分, 选出的阈值在留出集上误报率会失控。
 */
export function crossValidate(samples: readonly TrainSample[], o: TrainOptions, outerK = 8, innerK = 4, salt = ""): Prediction[] {
  const folds = assignFolds(samples.map((s) => s.group), outerK, salt);
  const out: Prediction[] = [];
  for (let f = 0; f < outerK; f++) {
    const train = samples.filter((s) => folds.get(s.group) !== f);
    const test = samples.filter((s) => folds.get(s.group) === f);
    if (!test.length || !train.some((s) => s.y === 1) || !train.some((s) => s.y === 0)) continue;
    const m = fitWithHonestThreshold(train, o, innerK);
    for (const s of test) {
      const score = scoreVector(m, extractFeatures(s.text, o.groups, { prevAssistant: s.prevAssistant }));
      out.push({ id: s.id, group: s.group, y: s.y, hit: score >= m.threshold, score, threshold: m.threshold, fold: String(f) });
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export interface Confusion {
  tp: number;
  fn: number;
  fp: number;
  tn: number;
  recall: number | null;
  fpr: number | null;
}

/** ROC AUC (Mann-Whitney), 与阈值无关, 用来看「得分本身能不能把正负分开」。 */
export function auc(scored: ReadonlyArray<{ score: number; y: 0 | 1 }>): number | null {
  const pos = scored.filter((r) => r.y === 1).map((r) => r.score);
  const neg = scored.filter((r) => r.y === 0).map((r) => r.score);
  if (!pos.length || !neg.length) return null;
  let s = 0;
  for (const p of pos) for (const n of neg) s += p > n ? 1 : p === n ? 0.5 : 0;
  return s / (pos.length * neg.length);
}

export function confusion(preds: ReadonlyArray<{ y: 0 | 1; hit: boolean }>): Confusion {
  let tp = 0, fn = 0, fp = 0, tn = 0;
  for (const p of preds) {
    if (p.y === 1) p.hit ? tp++ : fn++;
    else p.hit ? fp++ : tn++;
  }
  return {
    tp, fn, fp, tn,
    recall: tp + fn ? tp / (tp + fn) : null,
    fpr: fp + tn ? fp / (fp + tn) : null,
  };
}

/** Wilson 95% 区间, 用来判断两个候选的召回差是否超出样本量能区分的范围。 */
export function wilson(k: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0, 1];
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const r = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (c - r) / d), Math.min(1, (c + r) / d)];
}

/** 确定性伪随机 (mulberry32): 同一 seed ⇒ 同一序列, bootstrap 结果可逐位复现。 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface BootstrapCI {
  iters: number;
  seed: number;
  /** 按会话整组重采样 (cluster bootstrap): 同一会话的消息高度相关, 按条重采样会让区间过窄。 */
  unit: "session";
  recall: [number, number];
  fpr: [number, number];
}

/**
 * 会话级 bootstrap 95% 百分位区间 (2026-11-01, 选型规则从「留出 FPR 点估计 <= 0.05」改为看 FPR 区间)。
 * 每次有放回地抽与原来同样多的会话, 汇总其全部留出预测再算 recall / FPR; 某次抽样里没有正例 (或负例) 时该次的
 * recall (或 FPR) 不计入。区间取第 2.5 / 97.5 百分位 (下标 floor(0.025·n) 与 ceil(0.975·n)-1)。
 */
export function bootstrapCI(
  preds: ReadonlyArray<{ group: string; y: 0 | 1; hit: boolean }>,
  iters = 2000,
  seed = 20261101,
): BootstrapCI {
  const byGroup = new Map<string, { tp: number; fn: number; fp: number; tn: number }>();
  for (const p of preds) {
    const c = byGroup.get(p.group) ?? { tp: 0, fn: 0, fp: 0, tn: 0 };
    if (p.y === 1) p.hit ? c.tp++ : c.fn++;
    else p.hit ? c.fp++ : c.tn++;
    byGroup.set(p.group, c);
  }
  const groups = [...byGroup.keys()].sort();
  const rnd = mulberry32(seed);
  const rs: number[] = [];
  const fs: number[] = [];
  for (let i = 0; i < iters; i++) {
    let tp = 0, fn = 0, fp = 0, tn = 0;
    for (let j = 0; j < groups.length; j++) {
      const c = byGroup.get(groups[Math.floor(rnd() * groups.length)]!)!;
      tp += c.tp; fn += c.fn; fp += c.fp; tn += c.tn;
    }
    if (tp + fn) rs.push(tp / (tp + fn));
    if (fp + tn) fs.push(fp / (fp + tn));
  }
  const q = (xs: number[]): [number, number] => {
    if (!xs.length) return [0, 1];
    const s = [...xs].sort((a, b) => a - b);
    const r3 = (v: number) => Math.round(v * 1e4) / 1e4;
    return [r3(s[Math.floor(0.025 * s.length)]!), r3(s[Math.max(0, Math.ceil(0.975 * s.length) - 1)]!)];
  };
  return { iters, seed, unit: "session", recall: q(rs), fpr: q(fs) };
}
