// external/lightrag.ts — LightRAG。一个 baseUrl 对应一个 corpus, reset 清空该进程的文档。
import type { CanonicalDoc } from "./canonical.ts";
import { asRecord, requestJson, type HttpOptions } from "./http.ts";
import type { KnowledgeEngine, KnowledgeHit } from "./ports.ts";

const MARK = "hx-doc:";

export function lightRagKnowledgeEngine(opts: HttpOptions): KnowledgeEngine {
  return {
    id: "lightrag",
    capabilities: { markdown: true, images: false, pdf: false, ppt: false, html: false },

    async reset() {
      await requestJson(opts, "DELETE", "/documents");
    },

    async upsert(_corpusId, docs) {
      for (const doc of docs) {
        await requestJson(opts, "POST", "/documents/text", {
          text: project(doc),
          file_source: doc.id,
        });
      }
    },

    async search(_corpusId, query) {
      const json = asRecord(
        await requestJson(opts, "POST", "/query", {
          query: query.text,
          mode: "mix",
          only_need_context: true,
        }),
      );
      const fromChunks = chunkHits(json);
      if (fromChunks.length) return fromChunks.slice(0, query.limit);
      const response = typeof json.response === "string" ? json.response : "";
      return markerHits(response).slice(0, query.limit);
    },
  };
}

export function project(doc: CanonicalDoc): string {
  const captions = doc.assets
    .map((asset) => (asset.caption ? "image " + asset.path + ": " + asset.caption : "image " + asset.path))
    .join("\n");
  return MARK + doc.id + "\npath: " + doc.path + "\n" + doc.markdown + (captions ? "\n" + captions : "");
}

function chunkHits(json: Record<string, unknown>): KnowledgeHit[] {
  const data = asRecord(json.data);
  const chunks = Array.isArray(json.chunks) ? json.chunks : Array.isArray(data.chunks) ? data.chunks : [];
  const hits: KnowledgeHit[] = [];
  for (const chunk of chunks) {
    const row = asRecord(chunk);
    const source = typeof row.file_source === "string" ? row.file_source : typeof row.file_path === "string" ? row.file_path : "";
    const docId = source.startsWith(MARK) ? source.slice(MARK.length) : source;
    if (!/^[A-Za-z0-9_-]+$/.test(docId)) continue;
    const text = typeof row.content === "string" ? row.content : typeof row.text === "string" ? row.text : "";
    hits.push({ docId, text });
  }
  return hits;
}

function markerHits(response: string): KnowledgeHit[] {
  const hits: KnowledgeHit[] = [];
  const parts = response.split(MARK);
  for (const part of parts.slice(1)) {
    const line = part.split("\n")[0] ?? "";
    const docId = line.trim();
    if (!/^[A-Za-z0-9_-]+$/.test(docId)) continue;
    hits.push({ docId, text: part.slice(line.length).trim() });
  }
  return hits;
}
