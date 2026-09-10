// evolution/link.ts — 结构关联 (标签/实体共现) 的建边计划。
//
// 为什么需要它: 检索的图扩展通道需要"边"才有东西可扩展。只靠人工 link, 图上永远只有几条边;
// 而同一项目里共享标签/实体的记忆天然相关 —— 这是可以从真值直接推导出来的确定性关联。
//
// 边界:
//   - 只产出 relates 边 (权重 = 共现强度), 不改内容, 不动状态;
//   - 有上限 (默认最多 3 条): 关联爆炸比"少几条边"更糟, 会让图扩展把注入预算吃光;
//   - 不建实体节点 (entity:xxx): 实体表是后续能力, 现在建会造出永远查不到的悬空边。
import type { MemoryEntry, Relation } from "../kernel/types.ts";

export interface LinkPlanOptions {
  /** 单次写入最多建几条边 (默认 3)。 */
  maxLinks?: number;
  /** 共享实体的权重 (实体比标签更具体)。 */
  entityWeight?: number;
  /** 共享标签的权重。 */
  tagWeight?: number;
}

/**
 * 规划候选条目与既有条目之间的结构关联。纯函数, 无副作用。
 * 只有"共享至少一个实体或标签"的活跃条目才会被考虑。
 */
export function planStructuralLinks(
  candidate: Pick<MemoryEntry, "id" | "tags" | "entities">,
  existing: readonly MemoryEntry[],
  opts: LinkPlanOptions = {},
): Relation[] {
  const maxLinks = Math.max(0, opts.maxLinks ?? 3);
  if (maxLinks === 0) return [];
  const entityWeight = opts.entityWeight ?? 2;
  const tagWeight = opts.tagWeight ?? 1;
  const candidateTags = new Set(candidate.tags ?? []);
  const candidateEntities = new Set(candidate.entities ?? []);
  if (!candidateTags.size && !candidateEntities.size) return [];

  const scored: Array<{ id: string; score: number }> = [];
  for (const entry of existing) {
    if ((entry.status ?? "active") !== "active") continue;
    if (entry.id === candidate.id) continue;
    const sharedTags = (entry.tags ?? []).filter((t) => candidateTags.has(t)).length;
    const sharedEntities = (entry.entities ?? []).filter((e) => candidateEntities.has(e)).length;
    const score = sharedEntities * entityWeight + sharedTags * tagWeight;
    if (score <= 0) continue;
    scored.push({ id: entry.id, score });
  }
  return scored
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1))
    .slice(0, maxLinks)
    .map((s) => ({ type: "relates" as const, toId: s.id, weight: Math.min(1, s.score / 4) }));
}
