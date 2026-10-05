// src/app/facade-queries.ts — 门面的**纯查询**方法 (读存储 → 算结果 → 返回)。
//
// 为什么从 facade.ts 拆出 (2026-09-18): facade 的职责是"门面与编排" (写入的裁决链、
// 治理动作、审计), 而这一组方法只有"读-算-返回", 没有编排 —— 它们不关心写入路径的
// 任何决策, 也不产生副作用 (digest 刻意不落盘, 见下)。按"是否改变状态"拆开后,
// facade.ts 只剩真正需要编排的部分。
//
// 另一层收益: 这组方法的判据 (廉价投影 vs 全量、可见性口径) 现在集中在一处,
// 与 HybridRetriever 的降级路径共用同一条"优先用投影"的规则 (实测 10k 条: 6ms vs 137ms)。
import type { MemoryEntry } from "../kernel/types.ts";
import { estimateTokens } from "../kernel/ranking.ts";
import { selectAlwaysOnDetailed, type AlwaysOnSelection } from "../trigger/policy.ts";
import { aggregateStats } from "./stats.ts";
import type { MemoryStats } from "./facade-types.ts";
import { expandEvolutionChain } from "../kernel/evolution.ts";
import { isLiveEntry } from "../kernel/visibility.ts";
import type { Digest, DigestBuilder } from "./digest.ts";

/**
 * 这组查询方法所需的存储面 (只读)。
 *
 * entrySummaries 的返回类型必须是**投影**而不是完整 MemoryEntry —— 它存在的意义就是
 * "不 hydrate 关系/标签" (10k 条实测 6ms vs 137ms)。把它写成完整条目会让所有调用方
 * 类型不匹配, 进而诱使实现方去掉投影、退回全量读 (那正是这条快路径当初被加上的原因)。
 */
export interface QueryStore {
  get(id: string): Promise<MemoryEntry | null> | MemoryEntry | null;
  all(): Promise<MemoryEntry[]> | MemoryEntry[];
  /** 可选: 廉价投影 (单条 SQL, 不 hydrate 关系/标签)。有它时走快路径。 */
  entrySummaries?(): Promise<EntrySummary[]> | EntrySummary[];
  /** 可选: "最近沉淀"视图; 缺省时自行排序。 */
  recent?(limit?: number): Promise<MemoryEntry[]> | MemoryEntry[];
}

/** 选择 always-on / 摘要所需的字段集 (与 FacadeStore.entrySummaries 的投影一致)。 */
export type EntrySummary = Pick<
  MemoryEntry,
  | "id"
  | "kind"
  | "content"
  | "scope"
  | "project"
  | "importance"
  | "status"
  | "confirmedBy"
  | "confirmedAt"
>;

/** always-on 选择: 跨项目已确认规则 + 本项目关键事实/偏好/决策, 受 token 预算约束。 */
export async function queryAlwaysOn(
  store: QueryStore,
  opts: {
    project?: string;
    lineage?: readonly string[];
    budgetTokens?: number;
    ruleBudgetRatio?: number;
    /** 条数上限 (见 AlwaysOnOptions.maxEntries)。 */
    maxEntries?: number;
  } = {},
): Promise<MemoryEntry[]> {
  return (await queryAlwaysOnDetailed(store, opts)).entries;
}

/**
 * always-on 的**带报告**版本: 除了选中的条目, 还给出"本是候选但因配额没进来"的清单。
 *
 * 为什么需要它 (2026-09-18 实测): 真实库有 **9 条已确认规则, 而配额 240 token 只够 7 条** ——
 * 另 2 条**永远进不了保底通道**且**完全静默**。规则是用户确认过的不变量, 而 `always-on`
 * 的承诺是无条件注入 ⇒ "哪些被挡了"必须可查, 否则这个承诺无法被验证。
 */
export async function queryAlwaysOnDetailed(
  store: QueryStore,
  opts: {
    project?: string;
    lineage?: readonly string[];
    budgetTokens?: number;
    ruleBudgetRatio?: number;
    /** 条数上限 (见 AlwaysOnOptions.maxEntries: token 闸管长度, 条数闸管注意力)。 */
    maxEntries?: number;
  } = {},
): Promise<AlwaysOnSelection> {
  // 优先用廉价投影 (10k 条实测: 6ms vs 137ms)。投影字段对 selectAlwaysOn 足够。
  const candidates = store.entrySummaries ? await store.entrySummaries() : await store.all();
  return selectAlwaysOnDetailed(candidates as MemoryEntry[], {
    ...(opts.project ? { project: opts.project } : {}),
    ...(opts.lineage?.length ? { lineage: opts.lineage } : {}),
    budgetTokens: opts.budgetTokens ?? 400,
    ...(opts.ruleBudgetRatio === undefined ? {} : { ruleBudgetRatio: opts.ruleBudgetRatio }),
    ...(opts.maxEntries === undefined ? {} : { maxEntries: opts.maxEntries }),
    estimate: estimateTokens,
  });
}

/**
 * 最近落盘的记忆 (按写入时间倒序); 可见性口径与检索一致。
 *
 * ⚠ **用 `isLiveEntry`, 不是 `!== "shadow"`** (§695 修正): 注释早写着"与检索一致",
 * 而这里只挡了 shadow ⇒ 走这条降级路径时 (无 `store.recent` 的引擎) merged/expired 会漏出来。
 * 权威定义见 `kernel/visibility.ts`。
 */
export async function queryRecent(store: QueryStore, limit = 20): Promise<MemoryEntry[]> {
  if (store.recent) return (await store.recent(limit)).slice(0, limit);
  const all = await store.all();
  return all
    .filter(isLiveEntry)
    .sort((a, b) => (a.ts.assertedAt < b.ts.assertedAt ? 1 : a.ts.assertedAt > b.ts.assertedAt ? -1 : 0))
    .slice(0, limit);
}

/**
 * 生成一份"现在大概知道什么"的摘要。
 * 摘要**不落盘** —— 它是派生视图, 每次按当前库现算, 避免"摘要陈旧"这类失效。
 */
export async function queryDigest(
  store: QueryStore,
  builder: DigestBuilder,
  opts: { project?: string } = {},
): Promise<Digest> {
  // 投影字段对 digest 的选材足够 (它与 alwaysOn 用同一份投影口径); 强转与修复前的行为一致。
  const entries = (store.entrySummaries ? await store.entrySummaries() : await store.all()) as MemoryEntry[];
  return builder.build({ entries, ...(opts.project ? { project: opts.project } : {}) });
}

/** 演化链全历史 (最旧 → 最新), 用于"这条记忆怎么变成现在这样的"。 */
export async function queryHistory(store: QueryStore, id: string): Promise<MemoryEntry[]> {
  return expandEvolutionChain(await store.all(), id);
}

/** 全库统计 (面板/CLI 的概览)。 */
export async function queryStats(
  store: QueryStore,
  indexStatus?: () => unknown,
): Promise<MemoryStats> {
  const aggregated = aggregateStats(await store.all());
  return { ...aggregated, ...(indexStatus ? { index: indexStatus() } : {}) };
}
