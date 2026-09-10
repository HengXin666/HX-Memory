// kernel/ranking.ts — 检索结果的融合、衰减与预算裁剪 (纯函数, 无 IO, 无宿主依赖)。
//
// 为什么单独一层: v1 的排序是"关键词命中数", 既没有通道融合, 也没有时间衰减与预算;
// 换引擎时排序逻辑若散在存储实现里, 就会被一起换掉 (那不是我们想要的)。
// 这里集中三件事:
//   1. 多通道融合 (RRF, 不依赖各通道分数量纲);
//   2. 时间衰减 + 强化 (Ebbinghaus 式: 命中即延长半衰期);
//   3. 预算裁剪 (token 预算 > 条数上限, 因为"注入多少字"才是真实约束)。
import type { MemoryEntry, MemoryKind } from "./types.ts";

/** 一路召回结果 (已按该通道自己的分数降序)。 */
export interface RankedList {
  channel: string;
  ids: readonly string[];
  /** 通道权重 (默认 1): 用于给"必保"通道 (如已确认规则) 加权。 */
  weight?: number;
}

export interface FusedHit {
  id: string;
  score: number;
  channels: string[];
}

/**
 * Reciprocal Rank Fusion: score = Σ weight / (k + rank)。
 * 好处是只吃排名不吃原始分数 —— 换引擎/换打分函数时融合逻辑不用改。
 */
export function rrfFuse(lists: readonly RankedList[], k = 60): Map<string, FusedHit> {
  const fused = new Map<string, FusedHit>();
  for (const list of lists) {
    const weight = list.weight ?? 1;
    list.ids.forEach((id, index) => {
      const add = weight / (k + index + 1);
      const prev = fused.get(id);
      if (prev) {
        prev.score += add;
        if (!prev.channels.includes(list.channel)) prev.channels.push(list.channel);
      } else {
        fused.set(id, { id, score: add, channels: [list.channel] });
      }
    });
  }
  return fused;
}

/** 半衰期 (天) 按 kind 分档: 事件类快速淡出, 规则/决策长期有效。 */
export const HALF_LIFE_DAYS: Record<MemoryKind, number> = {
  event: 7,
  context: 30,
  fact: 180,
  lesson: 180,
  pattern: 180,
  preference: 365,
  decision: 365,
  rule: Number.POSITIVE_INFINITY,
};

/** 时间衰减因子 (0..1]; 半衰期 <= 0 或非有限 → 恒为 1 (不衰减)。 */
export function timeDecayFactor(ageDays: number, halfLifeDays: number): number {
  if (!Number.isFinite(halfLifeDays) || halfLifeDays <= 0) return 1;
  const age = Number.isFinite(ageDays) && ageDays > 0 ? ageDays : 0;
  return Math.pow(0.5, age / halfLifeDays);
}

/** 强化因子: 命中次数越多越"难忘"; 对数增长避免少数条目霸榜。 */
export function reinforcementFactor(hits: number | undefined): number {
  const n = Number.isFinite(hits) && (hits ?? 0) > 0 ? (hits as number) : 0;
  return 1 + Math.log1p(n) / 4;
}

export interface ScoreInput {
  base: number;
  entry: MemoryEntry;
  now: string;
  /** 显式信号 (标签命中/图扩展) 的额外加分。 */
  boost?: number;
}

/**
 * 综合打分 = 融合分 × 衰减 × 重要性 × 强化 + boost。
 * 缺字段时全部退化为中性值 (1), 因此对老数据 (无 importance/reinforcement) 行为不变。
 */
export function compositeScore(input: ScoreInput): number {
  const { entry, now } = input;
  const halfLife = HALF_LIFE_DAYS[entry.kind] ?? 180;
  const baseline = entry.lastHitAt ?? entry.ts.validAt;
  const ageDays = Math.max(0, (Date.parse(now) - Date.parse(baseline)) / 86_400_000);
  const decay = timeDecayFactor(Number.isFinite(ageDays) ? ageDays : 0, halfLife);
  const importance = clamp01(((entry.importance ?? 5) - 1) / 9);
  const importanceFactor = 0.6 + 0.4 * importance;
  const confidenceFactor = 0.7 + 0.3 * clamp01(entry.confidence ?? 0.7);
  return (
    input.base *
      decay *
      importanceFactor *
      confidenceFactor *
      reinforcementFactor(entry.reinforcement) +
    (input.boost ?? 0)
  );
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * 最大边际相关 (MMR) 去冗余: 在"相关性"与"和已选项的差异度"之间折中。
 * diversity 由调用方给出 (有 embedding 用余弦, 没有就用词集 Jaccard), 因此本函数不依赖向量能力。
 */
export function mmrSelect<T>(
  items: readonly T[],
  relevance: (item: T) => number,
  similarity: (a: T, b: T) => number,
  opts: { limit: number; lambda?: number },
): T[] {
  const lambda = opts.lambda ?? 0.7;
  const pool = [...items];
  const picked: T[] = [];
  while (pool.length && picked.length < opts.limit) {
    let bestIndex = 0;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < pool.length; i++) {
      const candidate = pool[i];
      if (candidate === undefined) continue;
      const rel = relevance(candidate);
      let maxSim = 0;
      for (const chosen of picked) {
        const sim = similarity(candidate, chosen);
        if (sim > maxSim) maxSim = sim;
      }
      const score = lambda * rel - (1 - lambda) * maxSim;
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }
    const [chosen] = pool.splice(bestIndex, 1);
    if (chosen !== undefined) picked.push(chosen);
  }
  return picked;
}

/**
 * 词集 Jaccard (输入已是词集)。
 * MMR 去冗余会把"每个候选 × 每个已选"都算一遍 (O(n²)) —— 若每次现算词集,
 * 就会退化成"每对都做两次分词" (实测这是万级检索的主要瓶颈)。
 * 因此调用方必须预计算词集, 这里只做集合运算。
 */
export function jaccardOfSets(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (!a.size || !b.size) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let inter = 0;
  for (const t of small) if (large.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/** 词集 Jaccard 相似度: 无 embedding 时的去冗余近似 (中英混排都可用)。 */
export function jaccardSimilarity(a: string, b: string): number {
  const setA = tokenSet(a);
  const setB = tokenSet(b);
  if (!setA.size || !setB.size) return 0;
  let inter = 0;
  for (const t of setA) if (setB.has(t)) inter++;
  return inter / (setA.size + setB.size - inter);
}

function tokenSet(text: string): Set<string> {
  const set = new Set<string>();
  for (const chunk of text
    .toLowerCase()
    .normalize("NFKC")
    .match(/[^\s]+/g) ?? []) {
    let run = "";
    const flush = () => {
      if (run.length === 1) set.add(run);
      else for (let i = 0; i + 1 < run.length; i++) set.add(run.slice(i, i + 2));
      run = "";
    };
    for (const ch of chunk) {
      if (/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/.test(ch)) run += ch;
      else flush();
    }
    flush();
    if (!/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/.test(chunk)) set.add(chunk);
  }
  return set;
}

/**
 * token 估算: 中文 1 字 ≈ 1 token, 拉丁 ≈ 4 字符 1 token。
 * 这是**预算用**的保守估计, 不是分词器; 宁可高估 (少注入) 也不要超预算。
 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/.test(ch)) cjk++;
    else other++;
  }
  return cjk + Math.ceil(other / 4);
}

export interface BudgetItem<T> {
  item: T;
  tokens: number;
  /** 保底组: 预算不足时优先保留 (例如"已确认的跨项目规则")。 */
  reserved?: boolean;
}

export interface BudgetResult<T> {
  kept: T[];
  dropped: Array<{ item: T; reason: "budget" }>;
  tokens: number;
}

/**
 * 预算裁剪: 先保 reserved 组 (组内按输入顺序), 再用剩余预算按输入顺序填充其余。
 * 顺序即优先级 —— 调用方应先按分数排序再进来。
 */
export function applyTokenBudget<T>(
  items: readonly BudgetItem<T>[],
  budget: number,
): BudgetResult<T> {
  const kept: T[] = [];
  const dropped: Array<{ item: T; reason: "budget" }> = [];
  let used = 0;
  for (const group of [true, false]) {
    for (const it of items) {
      if (Boolean(it.reserved) !== group) continue;
      if (kept.includes(it.item)) continue;
      if (used + it.tokens > budget) {
        dropped.push({ item: it.item, reason: "budget" });
        continue;
      }
      used += it.tokens;
      kept.push(it.item);
    }
  }
  return { kept, dropped, tokens: used };
}
