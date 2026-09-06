// kernel/evolution.ts — supersedes evolution chain semantics.
// Real implementation of the "hit any node → full ordered history" rule (design ADR-005).
//
// Pointer semantics (Hy-Memory-style, self-implemented):
//   supersedes  (new → old): the node replaces this older one.  Follow to find the OLDEST.
//   supersededBy(old → new): this node was replaced by that newer one. Follow to walk FORWARD.
import type { MemoryEntry } from "./types.js";

function targets(e: MemoryEntry, type: string): string[] {
  return (e.relations ?? []).filter((r) => r.type === type).map((r) => r.toId);
}

/**
 * Expand the full version chain containing startId (oldest first).
 * Hit ANY node → return the whole chain ordered oldest → newest, so consumers
 * can slice by validAt or pick the current version.
 */
export function expandEvolutionChain(
  entries: readonly MemoryEntry[],
  startId: string,
): MemoryEntry[] {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const seen = new Set<string>();

  // 1) Walk supersedes (new → old) to the oldest ancestor.
  let cur = byId.get(startId);
  let oldest = cur;
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    oldest = cur;
    const olderId = targets(cur, "supersedes")[0];
    cur = olderId ? byId.get(olderId) : undefined;
  }

  // 2) Walk forward via supersededBy (old → new), collecting every version.
  const chain: MemoryEntry[] = [];
  const seen2 = new Set<string>();
  cur = oldest;
  while (cur && !seen2.has(cur.id)) {
    seen2.add(cur.id);
    chain.push(cur);
    const newerId = targets(cur, "supersededBy")[0];
    cur = newerId ? byId.get(newerId) : undefined;
  }
  return chain;
}

/** Entries whose validAt <= at (pure bitemporal slice; supersession is orthogonal). */
export function sliceAt(entries: readonly MemoryEntry[], at: string): MemoryEntry[] {
  return entries.filter((e) => e.ts.validAt <= at);
}
