// retrieval/vector-sync.ts — 向量索引的**同步补齐** (从 hybrid.ts 拆出, §710 行数上限)。
//
// 为什么独立成文件: 这是"把真相同步进向量索引"这一件事, 与"怎么检索"是两类变化
// (前者随存储能力变, 后者随排序策略变)。它有一条**能力探测**的分支, 那正是本仓
// "降级必须说得清楚"的落点, 值得单独可读。
import type { MemoryEntry } from "../kernel/types.ts";
import type { IndexableSource, VectorIndex } from "../kernel/ports.ts";
import { isLiveEntry } from "./lifecycle.ts";

/** 同步所需的最小面 (由调用方传, 便于单测)。 */
export interface VectorSyncDeps {
  vectorIndex?: VectorIndex;
  /** 存储侧的能力面 (可能不支持 `indexDocs`/`revision`)。 */
  source: Partial<IndexableSource> & { query: (q: { limit: number }) => MemoryEntry[] };
}

/** 上次同步时的写版本号 (变了才重同步; 稳态下只做一次内存比较)。 */
export interface VectorSyncState {
  syncedRevision: number;
}

/**
 * 同步向量索引。
 *
 * 两条路:
 *   1. **廉价全量投影 + 写版本号** (存储支持时): 只在版本号变化时 upsert。这是主路径。
 *   2. **退回按查询扫描** (旧存储): 有上限 (`legacyLimit`), 且调用方应在结果里记 degraded 
 *      宁可说得清楚, 也不要静默漏 (扫描上限之外的知识 vector 通道看不见)。
 */
export function syncVectorIndex(deps: VectorSyncDeps, state: VectorSyncState): void {
  const index = deps.vectorIndex;
  if (!index) return;
  const indexable = deps.source;
  if (typeof indexable.indexDocs === "function" && typeof indexable.revision === "function") {
    const revision = indexable.revision();
    if (revision === state.syncedRevision) return;
    index.upsert(indexable.indexDocs());
    state.syncedRevision = revision;
    return;
  }
  const legacyLimit = 500;
  const candidates = deps.source.query({ limit: legacyLimit }).filter((e) => isLiveEntry(e));
  index.upsert(candidates.map((e) => ({ id: e.id, content: e.content })));
}
