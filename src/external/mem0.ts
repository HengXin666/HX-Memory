// external/mem0.ts — Mem0 OSS。无原生 reflect, 反思走 portableReflect。
// 自建服务没有 /v1 前缀: POST /memories, POST /search, DELETE /memories?user_id=
import { asRecord, requestJson, type HttpOptions } from "./http.ts";
import type { EngineHit, MemoryEngine } from "./ports.ts";

export function mem0MemoryEngine(opts: HttpOptions): MemoryEngine {
  return {
    id: "mem0",
    capabilities: { nativeReflect: false },

    async reset(bankId) {
      await requestJson(opts, "DELETE", "/memories?user_id=" + encodeURIComponent(bankId));
    },

    async upsert(bankId, records) {
      for (const record of records) {
        await requestJson(opts, "POST", "/memories", {
          messages: [{ role: "user", content: record.text }],
          user_id: bankId,
          metadata: {
            hx_id: record.id,
            hx_kind: record.kind,
            hx_entities: record.entities.join(","),
          },
        });
      }
    },

    async recall(bankId, query) {
      const json = await requestJson(opts, "POST", "/search", {
        query: query.text,
        user_id: bankId,
      });
      return take(json, query.limit);
    },
  };
}

function take(json: unknown, limit: number): EngineHit[] {
  const row = asRecord(json);
  const list = Array.isArray(json) ? json : Array.isArray(row.results) ? row.results : [];
  const hits: EngineHit[] = [];
  for (const item of list) {
    const meta = asRecord(asRecord(item).metadata);
    const id = typeof meta.hx_id === "string" ? meta.hx_id : "";
    if (!id) continue;
    const hit: EngineHit = { canonicalId: id };
    const score = asRecord(item).score;
    if (typeof score === "number") hit.score = score;
    hits.push(hit);
    if (hits.length >= limit) break;
  }
  return hits;
}
