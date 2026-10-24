// external/hindsight.ts — Hindsight (MIT) 的投影。召回只认我们写进去的 document_id。
import type { CanonicalMemory } from "./canonical.ts";
import { asRecord, hxIdOf, requestJson, type HttpOptions } from "./http.ts";
import type { EngineHit, MemoryEngine, MemoryQuery, Reflection } from "./ports.ts";

/**
 * 默认记忆引擎。bank = workspace。
 * 文档: POST /v1/default/banks/{bank}/memories|memories/recall|reflect
 */
export function hindsightMemoryEngine(opts: HttpOptions): MemoryEngine {
  return {
    id: "hindsight",
    capabilities: { nativeReflect: true },

    async reset(bankId) {
      const listed = await requestJson(opts, "GET", bankPath(bankId, "/memories/list"));
      const items = listItems(listed);
      for (const item of items) {
        const id = asRecord(item).id;
        if (typeof id !== "string" || !id) continue;
        await requestJson(opts, "DELETE", bankPath(bankId, "/memories/" + encodeURIComponent(id)));
      }
    },

    async upsert(bankId, records) {
      await requestJson(opts, "POST", bankPath(bankId, "/memories"), {
        async: false,
        items: records.map(toItem),
      });
    },

    async recall(bankId, query) {
      const json = await requestJson(opts, "POST", bankPath(bankId, "/memories/recall"), {
        query: query.text,
        max_tokens: 1200,
        ...(query.kinds ? { tags: [...query.kinds], tags_match: "any" } : {}),
      });
      return takeHits(json, query);
    },

    async reflect(bankId, input) {
      const json = asRecord(
        await requestJson(opts, "POST", bankPath(bankId, "/reflect"), {
          query: input.disposition + "\n\n" + input.question + "\n\n" + input.context,
          include: { facts: true },
        }),
      );
      const text = typeof json.text === "string" ? json.text : "";
      const based = asRecord(json.based_on);
      const memories = Array.isArray(based.memories) ? based.memories : [];
      const citations = memories.map(hxIdOf).filter((id): id is string => id !== null);
      const insufficient = json.insufficient === true || (/^insufficient\b/i.test(text) && !text.replace(/insufficient/i, "").trim());
      return { text: insufficient ? "" : text, citations, insufficient } satisfies Reflection;
    },
  };
}

function bankPath(bankId: string, suffix: string): string {
  return "/v1/default/banks/" + encodeURIComponent(bankId) + suffix;
}

function toItem(record: CanonicalMemory): Record<string, unknown> {
  return {
    content: record.text,
    document_id: record.id,
    metadata: { hx_id: record.id, hx_kind: record.kind, hx_status: record.status },
    tags: [record.kind, ...record.entities],
    entities: record.entities.map((text) => ({ text })),
  };
}

function listItems(json: unknown): unknown[] {
  if (Array.isArray(json)) return json;
  const row = asRecord(json);
  if (Array.isArray(row.items)) return row.items;
  if (Array.isArray(row.results)) return row.results;
  return [];
}

function takeHits(json: unknown, query: MemoryQuery): EngineHit[] {
  const row = asRecord(json);
  const list = Array.isArray(json) ? json : Array.isArray(row.results) ? row.results : [];
  const hits: EngineHit[] = [];
  for (const item of list) {
    const id = hxIdOf(item);
    if (!id) continue;
    const score = asRecord(asRecord(item).scores).final;
    const hit: EngineHit = { canonicalId: id };
    if (typeof score === "number") hit.score = score;
    hits.push(hit);
    if (hits.length >= query.limit) break;
  }
  return hits;
}
