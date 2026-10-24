// external/ragflow.ts — RAGFlow (Apache-2.0)。文件名就是 canonical id, 不靠它的内部 id。
import type { CanonicalDoc } from "./canonical.ts";
import { authHeaders, engineFetch, joinUrl, type HttpOptions } from "./http.ts";
import { asRecord, requestJson } from "./http.ts";
import { EngineError, type KnowledgeEngine, type KnowledgeHit } from "./ports.ts";

export function ragflowKnowledgeEngine(opts: HttpOptions & { apiKey: string }): KnowledgeEngine {
  return {
    id: "ragflow",
    capabilities: { markdown: true, images: true, pdf: true, ppt: true, html: true },

    async reset(corpusId) {
      const listed = asRecord(await requestJson(opts, "GET", datasetPath(corpusId, "/documents?page=1&page_size=200")));
      const docs = Array.isArray(asRecord(listed.data).docs)
        ? (asRecord(listed.data).docs as unknown[])
        : Array.isArray(listed.docs)
          ? (listed.docs as unknown[])
          : [];
      const ids = docs.map((row) => asRecord(row).id).filter((id): id is string => typeof id === "string");
      if (!ids.length) return;
      await requestJson(opts, "DELETE", datasetPath(corpusId, "/documents"), { ids });
    },

    async upsert(corpusId, docs) {
      for (const doc of docs) await uploadOne(opts, corpusId, doc);
    },

    async search(corpusId, query) {
      const json = asRecord(
        await requestJson(opts, "POST", "/api/v1/retrieval", {
          question: query.text,
          dataset_ids: [corpusId],
          page: 1,
          page_size: query.limit,
          keyword: true,
        }),
      );
      const chunks = Array.isArray(asRecord(json.data).chunks) ? (asRecord(json.data).chunks as unknown[]) : [];
      const hits: KnowledgeHit[] = [];
      for (const chunk of chunks) {
        const row = asRecord(chunk);
        const name = typeof row.document_keyword === "string" ? row.document_keyword : "";
        const docId = docIdFromFileName(name);
        if (!docId) continue;
        const text = typeof row.content === "string" ? row.content : "";
        const hit: KnowledgeHit = { docId, text };
        if (typeof row.similarity === "number") hit.score = row.similarity;
        hits.push(hit);
      }
      return hits;
    },
  };
}

export function docIdFromFileName(name: string): string | null {
  const base = name.split("/").pop() ?? "";
  const stripped = base.replace(/\.(md|png|jpe?g|webp|gif|html|pdf|pptx?)$/i, "");
  const id = stripped.split("__")[0] ?? "";
  return /^[A-Za-z0-9_-]+$/.test(id) ? id : null;
}

async function uploadOne(opts: HttpOptions & { apiKey: string }, corpusId: string, doc: CanonicalDoc): Promise<void> {
  const fetchImpl = engineFetch(opts);
  const form = new FormData();
  form.append("file", new Blob([doc.markdown], { type: "text/markdown" }), doc.id + ".md");
  for (const asset of doc.assets) {
    if (!asset.bytesBase64) continue;
    const bytes = Buffer.from(asset.bytesBase64, "base64");
    const ext = extensionOf(asset);
    form.append(
      "file",
      new Blob([bytes], { type: asset.mediaType ?? "application/octet-stream" }),
      doc.id + "__" + safeAsset(asset.path) + ext,
    );
  }
  const res = await fetchImpl(joinUrl(opts.baseUrl, datasetPath(corpusId, "/documents")), {
    method: "POST",
    headers: authHeaders(opts.apiKey, false),
    body: form,
  });
  const text = await res.text();
  if (res.status >= 300) throw new EngineError("ragflow", res.status, text.slice(0, 200));
  const json = text ? (JSON.parse(text) as unknown) : {};
  const uploaded = uploadedIds(json);
  if (uploaded.length) {
    await requestJson(opts, "POST", datasetPath(corpusId, "/chunks"), { document_ids: uploaded });
  }
}

function datasetPath(corpusId: string, suffix: string): string {
  return "/api/v1/datasets/" + encodeURIComponent(corpusId) + suffix;
}

function uploadedIds(json: unknown): string[] {
  const data = asRecord(json).data;
  const rows = Array.isArray(data) ? data : data ? [data] : [];
  return rows.map((row) => asRecord(row).id).filter((id): id is string => typeof id === "string");
}

function extensionOf(asset: { path: string; mediaType?: string }): string {
  const fromPath = /\.[A-Za-z0-9]+$/.exec(asset.path)?.[0];
  if (fromPath) return fromPath.toLowerCase();
  if (asset.mediaType === "image/png") return ".png";
  if (asset.mediaType === "image/jpeg") return ".jpg";
  return "";
}

function safeAsset(path: string): string {
  const base = path.split("/").pop() ?? "asset";
  return base.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 40);
}
