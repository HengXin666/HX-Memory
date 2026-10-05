// src/retrieval/lifecycle.ts — 条目生命周期的两条判定 (可见性 / 演化链上溯)。
//
// 为什么独立成文件 (2026-09-18): 这两个判据都是**纯函数** (只依赖一个 traverse 回调),
// 却长期内联在 HybridRetriever 里 —— 于是它们既超了 hybrid.ts 的行数上限, 又因为被
// 关在类的私有方法里而只能通过整条检索链间接测试。
//
// 抽出的额外收益: "什么叫还活着"这条定义现在只有一处, 存储层重建、检索降级路径、
// 面板浏览三处若需要同一判据, 不必各自复写一份 (同类教训: 索引与查询必须共用同一分词函数)。
import type { MemoryEntry } from "../kernel/types.ts";

/**
 * 条目的默认可见性: shadow (人工撤回) / merged (已并入他条) / expired (衰减过期)
 * 都不参与检索; 其余 (含 superseded —— 演化链上的旧版本) 可见。
 *
 * 为什么 superseded 仍可见: 命中旧版本时由 resolveCurrentEntry 上溯到最新 active 版本,
 * 历史节点因此不是"必须被隐藏", 而是"有更好的替代"。
 */
// ⚠ **定义已搬到 `kernel/visibility.ts`** (2026-09-18, §693):
// 它在**四处 SQL 里各写一遍**过, 而权威定义只有一份 —— 那份现在是 `kernel/visibility.ts`
// (因为 `storage/` 依赖 `kernel/`, 不能反向依赖本层)。
// 这里保留 re-export 以免打断既有 import (本模块的语义仍是"生命周期判定")。
export { isLiveEntry, HIDDEN_STATUSES, visibleClause } from "../kernel/visibility.ts";

/** 沿演化链取后继节点的回调 (由调用方注入, 便于纯函数化与单测)。 */
export type TraverseFn = (id: string, relationType: string) => MemoryEntry[];

/**
 * 命中演化链上的旧版本时, 返回链上最新的 active 版本 (注入最新, 历史仍可查)。
 * 无链 / 链尾仍非 active → 返回原条目 (由调用方的可见性判定决定去留);
 * 链尾是 shadow/expired → 返回 null (明确"这条已经不存在了")。
 *
 * 上溯跳数上限 10: 防御循环链 (数据被手工改坏时不能无限循环)。
 */
export function resolveCurrentEntry(entry: MemoryEntry, traverse: TraverseFn): MemoryEntry | null {
  if ((entry.status ?? "active") === "active") return entry;
  if (entry.status === "shadow" || entry.status === "expired") return null;
  let current = entry;
  for (let hop = 0; hop < 10; hop++) {
    const next = traverse(current.id, "supersededBy")[0];
    if (!next) break;
    current = next;
  }
  const status = current.status ?? "active";
  if (status === "shadow" || status === "expired") return null;
  return current;
}
