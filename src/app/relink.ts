// src/app/relink.ts — 维护动作: 给**存量条目**重新建结构关联边 (只加 relates, 不动内容)。
//
// 为什么需要它 (2026-09-18 实测):
//   `withStructuralLinks` 只在**写入时**建边, 因此"建边判据改进"只对新条目生效 ——
//   存量条目永远停在旧口径上。实测真实库: active 154 条, 而 `relates` 边只有 **20 条**;
//   按当前判据重算可得约 **401 条** (覆盖 88%)。即图长期稀疏的一个直接原因是**历史存量没补上**。
//   (演进史: 09-13 引入建边时可建边的只有 LLM 产 entities 的条目; 09-16 加入确定性实体兜底后
//    "有可用实体"的定义变宽了, 但存量条目不会自动重算。)
//
// 与 T2 重放的区别 (关键): T2 是"重跑抽取器" —— 它会**重建条目本身** (内容可能变化、旧版置 superseded)。
//   本动作只补 `relates` 边, **不碰 content/kind/状态**, 因此对真相文件的改动面最小。
//
// 安全设计 (改真相文件的操作必须谨慎):
//   · **可干跑**: dryRun 只出报告不写盘 (与 consolidate/normalize 同一范式);
//   · **只增不减**: 已有的边不动 (包括用户显式建的), 只追加缺失的 relates;
//   · **幂等**: 重复跑不产生重复边 (按 (type, toId) 去重);
//   · **可审计**: 报告逐条列出新增了哪些边 (从哪条到哪条、权重)。
import type { Relation } from "../kernel/types.ts";
import type { MemoryStore } from "../kernel/ports.ts";
import { planStructuralLinks } from "../evolution/link.ts";

export interface RelinkChange {
  from: string;
  to: string;
  weight: number;
}

export interface RelinkReport {
  scanned: number;
  /** 有新边可加的条目数。 */
  changed: number;
  /** 本来就有边 (且无新增) 的条目数。 */
  unchanged: number;
  /** 新增边总数。 */
  added: number;
  /** 真跑了才为 true (dryRun 时为 false)。 */
  applied: boolean;
  dryRun: boolean;
  /** 新增边的明细 (上限 200 条, 避免报告本身过大)。 */
  changes: RelinkChange[];
}

export interface RelinkOptions {
  /** 干跑: 只报告不写盘。 */
  dryRun?: boolean;
  /** 单条最多建几条边 (默认 3, 与捕获路径同默认)。 */
  maxLinks?: number;
}

/**
 * 重新建边。
 *
 * 实现要点: 逐条与**全量既有条目**比较 (与捕获路径同一算法), 因此结果与"这些条目按新判据
 * 重新走一遍写入路径"一致 —— 复用 `planStructuralLinks` 而不是另写一套, 避免两处口径分叉
 * (这类分叉在本项目已出现过: 建边函数与它的前置门曾用不同的"有实体"定义)。
 */
export async function relinkAll(store: MemoryStore, opts: RelinkOptions = {}): Promise<RelinkReport> {
  const dryRun = opts.dryRun ?? false;
  const maxLinks = opts.maxLinks ?? 3;
  const all = await store.all();
  const report: RelinkReport = {
    scanned: all.length,
    changed: 0,
    unchanged: 0,
    added: 0,
    applied: !dryRun,
    dryRun,
    changes: [],
  };
  if (maxLinks <= 0) return report;

  for (const entry of all) {
    if ((entry.status ?? "active") !== "active") continue;
    const planned = planStructuralLinks(entry, all, { maxLinks });
    const existing: Relation[] = [...(entry.relations ?? [])];
    const fresh = planned.filter(
      (p) => !existing.some((r) => r.type === p.type && r.toId === p.toId),
    );
    if (!fresh.length) {
      report.unchanged++;
      continue;
    }
    report.changed++;
    report.added += fresh.length;
    for (const r of fresh) {
      if (report.changes.length < 200) {
        report.changes.push({ from: entry.id, to: r.toId, weight: r.weight ?? 0 });
      }
    }
    if (!dryRun) {
      // 只追加: 原有边 (含人工显式建的) 一律保留 —— 维护动作不该覆盖人的决定。
      await store.update(entry.id, { relations: [...existing, ...fresh] });
    }
  }
  return report;
}
