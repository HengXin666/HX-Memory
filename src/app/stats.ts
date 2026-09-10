// app/stats.ts — 记忆库的**统计聚合** (纯函数: 条目集合 → 统计视图)。
//
// 为什么独立: 这是面板/CLI 的可观测面, 计算过程纯粹是对集合的分类计数,
// 与 Facade 的编排职责无关。抽成纯函数后它可以被单测直接喂数据 (不需要真存储),
// 而 facade.stats() 只剩"取数据 → 调它 → 附上引擎状态"。
import type { MemoryEntry, MemoryKind, MemoryStatus } from "../kernel/types.ts";
import type { MemoryStats } from "./facade-types.ts";

/** 按 kind/status/项目 分类计数; rules 只算"已确认"的 (未确认规则不入库, 但真相文件里可能有)。 */
export function aggregateStats(entries: readonly MemoryEntry[]): Omit<MemoryStats, "index"> {
  const byKind: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  const projects = new Set<string>();
  let rules = 0;
  for (const e of entries) {
    byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
    const status: MemoryStatus = e.status ?? "active";
    byStatus[status] = (byStatus[status] ?? 0) + 1;
    if (e.project) projects.add(e.project);
    if (e.kind === "rule" && e.confirmedBy && e.confirmedAt) rules++;
  }
  void (null as unknown as MemoryKind);
  return {
    total: entries.length,
    byKind,
    byStatus,
    projects: [...projects].sort(),
    rules,
  };
}
