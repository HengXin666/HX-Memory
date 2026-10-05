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
import { entityKey, entitiesOf } from "../kernel/entity.ts";

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
 *
 * 实体口径 (2026-09-18 修复): 建边读的是 `entitiesOf` 而不是 `entry.entities` 字段。
 *
 * 为什么必须这样: 确定性实体抽取器 (`kernel/entity.ts`) 刻意把兜底放在**索引侧**
 * (实体是派生物, 不写回真相文件, 换抽取器时不必迁移人的文件 —— 该取舍保留)。但建边走的是
 * 真相条目的 `entities` 字段, 而该字段只有 LLM 结构化器会写、实测填充率仅 13% ——
 * 于是"索引里有实体、建边却看不到", 建边在多数条目上直接短路返回空。
 * 实测证据 (125 条真实语料): 边/节点 = 0.24, 孤立节点 67.2%, 最大连通分量仅 6 条;
 * 图扩展通道在 1204 次召回里只贡献 7 条 —— 图是死的, 不是没接, 是**没边可扩**。
 * 对照实验: 把边建对 (oracle 边) 后同预算下多 gold 完整率 0.922 → 0.945, 图通道贡献 7 → 354 条。
 * 因此建边与索引反查必须共用同一套实体口径 (`entityKey` 归一), 否则两侧静默分叉 (同类坑见 kernel/cjk.ts)。
 */
export function planStructuralLinks(
  candidate: Pick<MemoryEntry, "id" | "tags" | "entities"> & { content?: string },
  existing: readonly MemoryEntry[],
  opts: LinkPlanOptions = {},
): Relation[] {
  const maxLinks = Math.max(0, opts.maxLinks ?? 3);
  if (maxLinks === 0) return [];
  const entityWeight = opts.entityWeight ?? 2;
  const tagWeight = opts.tagWeight ?? 1;
  const candidateTags = new Set(candidate.tags ?? []);
  // 用**归一后的实体键**比较: 显式字段与确定性兜底混在一起时, "HX-Memory" 与 "hx-memory"
  // 必须算同一个实体, 否则共现永远匹配不上 (索引侧用的就是 entityKey)。
  const candidateEntities = new Set(entitiesOf(candidate).map(entityKey).filter(Boolean));
  if (!candidateTags.size && !candidateEntities.size) return [];

  const scored: Array<{ id: string; score: number }> = [];
  for (const entry of existing) {
    if ((entry.status ?? "active") !== "active") continue;
    if (entry.id === candidate.id) continue;
    const sharedTags = (entry.tags ?? []).filter((t) => candidateTags.has(t)).length;
    const entryEntities = new Set(entitiesOf(entry).map(entityKey).filter(Boolean));
    let sharedEntities = 0;
    for (const key of candidateEntities) if (entryEntities.has(key)) sharedEntities++;
    const score = sharedEntities * entityWeight + sharedTags * tagWeight;
    if (score <= 0) continue;
    scored.push({ id: entry.id, score });
  }
  return scored
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1))
    .slice(0, maxLinks)
    .map((s) => ({ type: "relates" as const, toId: s.id, weight: Math.min(1, s.score / 4) }));
}
