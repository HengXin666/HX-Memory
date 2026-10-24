// external/lexical.ts — 没有远端地址时的进程内投影。字段仍是 canonical，不另存一份真相。
import type { CanonicalDoc, CanonicalMemory } from "./canonical.ts";
import type { EngineHit, KnowledgeEngine, KnowledgeHit, MemoryEngine, MemoryQuery } from "./ports.ts";

/**
 * 词面重叠。只在远端引擎没配地址时使用，好让 DSH 仍走同一套宿主。
 * 换上 Hindsight / RAGFlow 不改调用方。
 */
export function lexicalMemoryEngine(): MemoryEngine {
  const banks = new Map<string, Map<string, IndexedMemory>>();
  return {
    id: "lexical",
    capabilities: { nativeReflect: false },
    async reset(bankId) {
      banks.delete(bankId);
    },
    async upsert(bankId, records) {
      const bag = banks.get(bankId) ?? new Map<string, IndexedMemory>();
      for (const record of records) bag.set(record.id, indexMemory(record));
      banks.set(bankId, bag);
    },
    async recall(bankId, query) {
      const bag = banks.get(bankId);
      if (!bag) return [];
      return rank(bag.values(), query);
    },
  };
}

export function lexicalKnowledgeEngine(): KnowledgeEngine {
  const corpora = new Map<string, Map<string, IndexedDoc>>();
  return {
    id: "lexical",
    capabilities: { markdown: true, images: false, pdf: false, ppt: false, html: false },
    async reset(corpusId) {
      corpora.delete(corpusId);
    },
    async upsert(corpusId, docs) {
      const bag = corpora.get(corpusId) ?? new Map<string, IndexedDoc>();
      for (const doc of docs) bag.set(doc.id, indexDoc(doc));
      corpora.set(corpusId, bag);
    },
    async search(corpusId, query) {
      const bag = corpora.get(corpusId);
      if (!bag) return [];
      const hits: KnowledgeHit[] = [];
      const needle = tokenSet(query.text);
      if (!needle.size) return hits;
      const ranked = [...bag.values()]
        .map((doc) => ({ doc, score: overlap(needle, doc.tokens) }))
        .filter((row) => row.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, query.limit);
      for (const row of ranked) {
        hits.push({ docId: row.doc.doc.id, text: snippet(row.doc.doc, needle), score: row.score });
      }
      return hits;
    },
  };
}

interface IndexedMemory {
  record: CanonicalMemory;
  tokens: Set<string>;
}

interface IndexedDoc {
  doc: CanonicalDoc;
  tokens: Set<string>;
}

function indexMemory(record: CanonicalMemory): IndexedMemory {
  return { record, tokens: tokenSet(record.text + " " + record.entities.join(" ") + " " + record.kind) };
}

function indexDoc(doc: CanonicalDoc): IndexedDoc {
  const captions = doc.assets.map((asset) => asset.caption ?? "").join(" ");
  return { doc, tokens: tokenSet(doc.path + "\n" + doc.markdown + "\n" + captions) };
}

function rank(rows: Iterable<IndexedMemory>, query: MemoryQuery): EngineHit[] {
  const needle = tokenSet(query.text);
  if (!needle.size) return [];
  const hits: EngineHit[] = [];
  for (const row of rows) {
    if (row.record.status !== "active") continue;
    if (query.kinds && !query.kinds.includes(row.record.kind)) continue;
    const score = overlap(needle, row.tokens);
    if (score <= 0) continue;
    hits.push({ canonicalId: row.record.id, score });
  }
  hits.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  return hits.slice(0, query.limit);
}

function snippet(doc: CanonicalDoc, needle: Set<string>): string {
  const lines = doc.markdown.split("\n");
  const hit = lines.find((line) => overlap(needle, tokenSet(line)) > 0);
  const caption = doc.assets.find((asset) => asset.caption && overlap(needle, tokenSet(asset.caption)) > 0)?.caption;
  return [hit, caption].filter(Boolean).join("\n") || doc.markdown.slice(0, 240);
}

function overlap(needle: Set<string>, hay: Set<string>): number {
  let n = 0;
  for (const token of needle) if (hay.has(token)) n += 1;
  return n;
}

function tokenSet(text: string): Set<string> {
  const out = new Set<string>();
  const latin = text.toLowerCase().match(/[a-z0-9_./-]{2,}/g) ?? [];
  for (const token of latin) out.add(token);
  const cjk = text.match(/[\u4e00-\u9fff]/g) ?? [];
  for (let i = 0; i < cjk.length; i++) {
    out.add(cjk[i] ?? "");
    if (i + 1 < cjk.length) out.add((cjk[i] ?? "") + (cjk[i + 1] ?? ""));
  }
  out.delete("");
  return out;
}
