// retrieval/assemble.ts — 融合之后的收尾: 去冗余、预算裁剪、图候选补位、返回顺序。
//
// 为什么独立成文件: 这一段的职责是"把已经算好分的候选整理成最终命中列表", 与
// hybrid.ts 关心的"从各通道取数并融合"是两件事 —— 前者改排序策略, 后者改通道与取数。
// 它们的变化原因不同 (历史上排序缺陷改了三次, 通道增删改过两次), 放在一起会让
// 最长的那段逻辑淹没另一段 (实测 hybrid.ts 破 400 行上限)。
//
// 依赖: 只用 kernel 的纯函数与类型, 不认识存储/宿主 (引擎层铁律)。
import type { MemoryEntry } from "../kernel/types.ts";
import type { Channel, RetrievalHit, RetrievalResult } from "../kernel/ports.ts";
import { applyTokenBudget, estimateTokens, jaccardOfSets, mmrSelect } from "../kernel/ranking.ts";

/** 一条已打分的候选 (融合 + 演化链上溯之后)。 */
export interface ScoredCandidate {
  entry: MemoryEntry;
  score: number;
  channels: Channel[];
  why: string;
}

export interface AssembleOptions {
  limit: number;
  tokenBudget: number;
  mmrLambda: number;
  /** 图候选的补位配额 (0 = 不追加)。 */
  graphTierQuota: number;
  /** 图候选 id (来自第二梯队通道)。 */
  tier2Ids: readonly string[];
  /** 词集缓存 (MMR 的多样性用)。 */
  tokensOf: (e: MemoryEntry) => ReadonlySet<string>;
  /** 解析 id → 当前版本条目 (演化链上溯); 返回 null 表示不可用。 */
  resolve: (id: string) => MemoryEntry | null;
  /** 记录图候选的 why。 */
  whyOf: (id: string) => string;
}

/** 图候选追加时使用的固定分数: 它不在同一条相关性尺度上。 */
export const GRAPH_TIER_SCORE = 0;

/**
 * 整理最终命中列表。
 *
 * 顺序上有一条**必须**遵守的规则: 返回顺序按综合分降序。
 * MMR 的产出是"挑选顺序" (相关性 × 差异度的折中), 不是相关度顺序; 直接把它当排名用会让
 * 分数最高的条目排到后面 (实测 gold 分数全场最高却排第 2)。预算的 reserved 语义保护的是
 * "是否入选", 不是"排在第几", 因此重排不破坏规则保底。
 */
export function assembleHits(
  resolved: readonly ScoredCandidate[],
  opts: AssembleOptions,
): RetrievalResult {
  const sorted = [...resolved].sort((a, b) => b.score - a.score);

  // MMR 去冗余 (没有 embedding 时用词集 Jaccard)
  const diverse = mmrSelect(
    sorted,
    (h) => h.score,
    (a, b) => jaccardOfSets(opts.tokensOf(a.entry), opts.tokensOf(b.entry)),
    { limit: Math.max(opts.limit * 4, opts.limit + 8), lambda: opts.mmrLambda },
  );

  // 预算裁剪 (规则保底)
  const budgeted = applyTokenBudget(
    diverse.map((h) => ({
      item: h,
      tokens: estimateTokens(h.entry.content) + 8,
      reserved: h.channels.includes("rules") || h.entry.kind === "rule",
    })),
    opts.tokenBudget,
  );

  const primary = budgeted.kept.slice().sort((a, b) => b.score - a.score);

  // ---- 图候选作为尾巴追加 (第二梯队) ----
  // 只在主榜单没填满时补位, 不参与上面的打分竞争。重复项与演化链上溯后的重复项都跳过。
  const extras: RetrievalHit[] = [];
  for (const id of opts.tier2Ids.slice(0, opts.graphTierQuota)) {
    if (primary.length + extras.length >= opts.limit) break;
    if (primary.some((h) => h.entry.id === id)) continue;
    if (extras.some((h) => h.entry.id === id)) continue;
    const current = opts.resolve(id);
    if (!current || primary.some((h) => h.entry.id === current.id)) continue;
    if (extras.some((h) => h.entry.id === current.id)) continue;
    extras.push({
      entry: current,
      score: GRAPH_TIER_SCORE,
      channels: ["graph"],
      why: opts.whyOf(id),
    });
  }

  const finalHits: RetrievalHit[] = [...primary.slice(0, opts.limit), ...extras];

  const dropped: RetrievalResult["dropped"] = budgeted.dropped.map((d) => ({
    id: d.item.entry.id,
    reason: "budget",
  }));
  for (const h of diverse) {
    if (finalHits.some((f) => f.entry.id === h.entry.id)) continue;
    if (dropped.some((d) => d.id === h.entry.id)) continue;
    dropped.push({ id: h.entry.id, reason: "filtered" });
  }

  return {
    hits: finalHits,
    tokens: finalHits.reduce((n, h) => n + estimateTokens(h.entry.content) + 8, 0),
    dropped,
    degraded: [],
  };
}
