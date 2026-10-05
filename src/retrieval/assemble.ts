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
  /** 实体反查候选的配额 (0 = 不追加)。与图配额分开 —— 两个通道的候选质量不同。 */
  entityQuota: number;
  /** 第二梯队候选 (不与主榜单竞争分数; 各自占独立配额)。channel 决定它吃哪份配额。 */
  tier2: ReadonlyArray<{ id: string; channel: string }>;
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

  // ---- 第二梯队作为尾巴追加 (图扩展 / 实体反查) ----
  // 只在主榜单没填满时补位, 不参与上面的打分竞争。重复项与演化链上溯后的重复项都跳过。
  // **配额按通道分别计**: 两个通道的候选质量不同 (实体反查的精度高于实体共现的图边),
  // 合成一份配额会让一个通道的长列表把另一个挤掉。
  const quotaLeft = new Map<string, number>([
    ["graph", opts.graphTierQuota],
    ["entity", opts.entityQuota],
  ]);
  const extras: RetrievalHit[] = [];
  for (const { id, channel } of opts.tier2) {
    if (primary.length + extras.length >= opts.limit) break;
    const left = quotaLeft.get(channel) ?? 0;
    if (left <= 0) continue;
    if (primary.some((h) => h.entry.id === id)) continue;
    if (extras.some((h) => h.entry.id === id)) continue;
    const current = opts.resolve(id);
    if (!current || primary.some((h) => h.entry.id === current.id)) continue;
    if (extras.some((h) => h.entry.id === current.id)) continue;
    quotaLeft.set(channel, left - 1);
    extras.push({
      entry: current,
      score: GRAPH_TIER_SCORE,
      channels: [channel as RetrievalHit["channels"][number]],
      why: opts.whyOf(id),
    });
  }

  // ⚠ 2026-09-18 修复: extras 此前**无条件追加**, 完全绕过 tokenBudget ——
  // 实测 (真实库, tokenBudget=100): 返回的 6 条**全部来自 graph/entity**, 单条最大 1400 token
  // (总预算的 14 倍); 而预算内的 primary **一条都没进**。注入路径因此超支 5.8 倍 (实测 4994 vs 700)。
  //
  // 修法: extras 只在**预算还有余量**时追加。这与既有契约**不冲突** ——
  // 契约场景 (conformance 的"图扩展邻居被召回") 不传 tokenBudget, 走默认 1200, 余量充足;
  // 而"预算紧张时优先保证主榜单"是预算机制的应有之义 (它此前只对 primary 生效)。
  const extraBudget = Math.max(0, opts.tokenBudget - budgeted.tokens);
  let extraUsed = 0;
  const extrasWithinBudget: RetrievalHit[] = [];
  for (const it of extras) {
    const cost = estimateTokens(it.entry.content) + 8;
    if (extraUsed + cost > extraBudget) break;
    extraUsed += cost;
    extrasWithinBudget.push(it);
  }
  // 被预算挡掉的 extras 记为 dropped (可观测: "它不该回收"这个判断要能被问出来)。
  const extraDropped = extras.filter((it) => !extrasWithinBudget.includes(it));

  const finalHits: RetrievalHit[] = [...primary.slice(0, opts.limit), ...extrasWithinBudget];

  const dropped: RetrievalResult["dropped"] = budgeted.dropped.map((d) => ({
    id: d.item.entry.id,
    reason: "budget",
  }));
  for (const it of extraDropped) dropped.push({ id: it.entry.id, reason: "budget" });
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
