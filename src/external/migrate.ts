// external/migrate.ts — 换引擎 = 清空投影 + 把 canonical 再喂一遍。
import type { CanonicalStore } from "./store.ts";
import type { KnowledgeEngine, MemoryEngine } from "./ports.ts";

/** 重放一个 bank。返回写入的有效条数。失效条目不进索引, 召回时再滤一层。 */
export async function reindexMemory(
  store: CanonicalStore,
  engine: MemoryEngine,
  bankId: string,
): Promise<number> {
  await engine.reset(bankId);
  const live = store.listMemories(bankId).filter((row) => row.status === "active");
  if (live.length) await engine.upsert(bankId, live);
  for (const row of store.listMemories(bankId)) {
    store.saveMemory({ ...row, indexState: row.status === "active" ? "indexed" : row.indexState });
  }
  return live.length;
}

/** 重放一个 corpus。文档包是迁移单位, 不从 RAG 索引反推原文。 */
export async function reindexKnowledge(
  store: CanonicalStore,
  engine: KnowledgeEngine,
  corpusId: string,
): Promise<number> {
  await engine.reset(corpusId);
  const docs = store.listDocs(corpusId);
  if (docs.length) await engine.upsert(corpusId, docs);
  for (const doc of docs) store.saveDoc({ ...doc, indexState: "indexed" });
  return docs.length;
}

/**
 * 两个引擎对同一份 canonical 的召回 id 集合必须一致 (在两边都能字面命中时)。
 * 测的是迁移, 不是各家排序算法。
 */
export async function sameLiveIds(
  store: CanonicalStore,
  engine: MemoryEngine,
  bankId: string,
  probe: string,
): Promise<string[]> {
  const hits = await engine.recall(bankId, { text: probe, limit: 50 });
  const live = new Set(
    store
      .listMemories(bankId)
      .filter((row) => row.status === "active")
      .map((row) => row.id),
  );
  return hits.map((hit) => hit.canonicalId).filter((id) => live.has(id));
}
