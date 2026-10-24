import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createExternalHost } from "../../src/external/host.ts";
import { hindsightMemoryEngine } from "../../src/external/hindsight.ts";
import { lightRagKnowledgeEngine, project } from "../../src/external/lightrag.ts";
import { mem0MemoryEngine } from "../../src/external/mem0.ts";
import { docIdFromFileName, ragflowKnowledgeEngine } from "../../src/external/ragflow.ts";
import { EngineError } from "../../src/external/ports.ts";
import type { CanonicalDoc } from "../../src/external/canonical.ts";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("engine adapters", () => {
  it("keeps canonical text when hindsight rewrites the fact, and replays onto mem0", async () => {
    const banks = new Map<string, Map<string, { text: string; kind: string }>>();
    const hindsight = hindsightMemoryEngine({
      baseUrl: "http://hindsight.local",
      fetchImpl: async (input, init) => {
        const url = String(input);
        const bank = decodeURIComponent(url.split("/banks/")[1]?.split("/")[0] ?? "");
        const bucket = banks.get(bank) ?? new Map();
        banks.set(bank, bucket);
        if (url.endsWith("/memories") && init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as { items: Array<{ document_id: string; content: string; metadata: { hx_kind: string } }> };
          for (const item of body.items) bucket.set(item.document_id, { text: item.content, kind: item.metadata.hx_kind });
          return json({ success: true });
        }
        if (url.endsWith("/memories/recall")) {
          return json({
            results: [...bucket.entries()].map(([id, row]) => ({
              text: "改写后的事实 " + id,
              document_id: id,
              metadata: { hx_id: id },
              scores: { final: 0.9 },
            })),
          });
        }
        if (url.endsWith("/memories/list")) {
          return json({ items: [...bucket.keys()].map((id) => ({ id: "hs_" + id })) });
        }
        if (init?.method === "DELETE") {
          const id = decodeURIComponent(url.split("/memories/")[1] ?? "");
          bucket.delete(id.replace(/^hs_/, ""));
          return json({ ok: true });
        }
        return json({ error: url }, 404);
      },
    });
    const mem0Rows = new Map<string, Array<{ id: string; text: string }>>();
    const mem0 = mem0MemoryEngine({
      baseUrl: "http://mem0.local",
      fetchImpl: async (input, init) => {
        const url = String(input);
        if (url.endsWith("/memories") && init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as {
            user_id: string;
            messages: Array<{ content: string }>;
            metadata: { hx_id: string };
          };
          const list = mem0Rows.get(body.user_id) ?? [];
          list.push({ id: body.metadata.hx_id, text: body.messages[0]?.content ?? "" });
          mem0Rows.set(body.user_id, list);
          return json({ results: [{ id: "m1", event: "ADD" }] });
        }
        if (url.endsWith("/search")) {
          const body = JSON.parse(String(init?.body ?? "{}")) as { user_id: string };
          return json({
            results: (mem0Rows.get(body.user_id) ?? []).map((row) => ({
              memory: "mem0 改写 " + row.id,
              metadata: { hx_id: row.id },
              score: 0.4,
            })),
          });
        }
        if (init?.method === "DELETE") {
          const user = new URL(url).searchParams.get("user_id") ?? "";
          mem0Rows.set(user, []);
          return json({ ok: true });
        }
        return json({ error: url }, 404);
      },
    });
    const dir = mkdtempSync(join(tmpdir(), "hx-eng-"));
    const host = createExternalHost({
      root: dir,
      memory: hindsight,
      knowledge: lightRagKnowledgeEngine({ baseUrl: "http://unused.local", fetchImpl: async () => json({}) }),
      now: () => "2026-10-24T00:00:00.000Z",
    });
    const saved = await host.retain({ bankId: "ws_a", kind: "decision", text: "鉴权放在 src/auth.ts" });
    const viewed = await host.recall({ bankId: "ws_a", query: "鉴权" });
    expect(viewed[0]?.record.text).toBe("鉴权放在 src/auth.ts");
    expect(viewed[0]?.record.text).not.toContain("改写");
    await host.swapMemory(mem0);
    const moved = await host.recall({ bankId: "ws_a", query: "鉴权" });
    expect(moved.map((view) => view.record.id)).toEqual([saved.id]);
    expect(moved[0]?.record.text).toBe("鉴权放在 src/auth.ts");
    expect(mem0Rows.get("ws_a")?.[0]?.id).toBe(saved.id);
  });

  it("leaves the canonical record pending when the engine is down", async () => {
    const memory = hindsightMemoryEngine({
      baseUrl: "http://hindsight.local",
      fetchImpl: async () => new Response("down", { status: 503 }),
    });
    const host = createExternalHost({
      root: mkdtempSync(join(tmpdir(), "hx-down-")),
      memory,
      knowledge: lightRagKnowledgeEngine({ baseUrl: "http://unused.local", fetchImpl: async () => json({}) }),
    });
    const saved = await host.retain({ bankId: "ws_a", kind: "decision", text: "先写 canonical" });
    expect(saved.indexState).toBe("pending");
    expect(host.store.getMemory("ws_a", saved.id)?.text).toBe("先写 canonical");
    await expect(memory.reset("ws_a")).rejects.toBeInstanceOf(EngineError);
  });

  it("maps ragflow filenames and lightrag markers back to canonical docs", async () => {
    expect(docIdFromFileName("hx_doc1.md")).toBe("hx_doc1");
    expect(docIdFromFileName("hx_doc1__shot.png")).toBe("hx_doc1");
    const uploaded: string[] = [];
    const ragflow = ragflowKnowledgeEngine({
      baseUrl: "http://ragflow.local",
      apiKey: "secret",
      fetchImpl: async (input, init) => {
        const url = String(input);
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret");
        if (url.endsWith("/documents") && init?.method === "POST") {
          const form = init.body as FormData;
          for (const file of form.getAll("file")) {
            if (file instanceof File) uploaded.push(file.name);
          }
          return json({ code: 0, data: [{ id: "rf_1", name: uploaded[0] }] });
        }
        if (url.endsWith("/chunks")) return json({ code: 0 });
        if (url.includes("/documents?")) return json({ data: { docs: [] } });
        if (url.endsWith("/retrieval")) {
          return json({ data: { chunks: [{ content: "引擎切出来的片段", document_keyword: "hx_doc1.md", similarity: 0.8 }] } });
        }
        return json({ error: url }, 404);
      },
    });
    const dir = mkdtempSync(join(tmpdir(), "hx-kb-"));
    const host = createExternalHost({
      root: dir,
      memory: mem0MemoryEngine({ baseUrl: "http://mem0.local", fetchImpl: async () => json({ results: [] }) }),
      knowledge: ragflow,
    });
    const doc: Omit<CanonicalDoc, "sha256" | "indexState" | "corpusId"> = {
      id: "hx_doc1",
      path: "docs/auth.md",
      markdown: "登录校验 exp",
      assets: [{ path: "docs/auth.png", caption: "右上角是过期时间", mediaType: "image/png", bytesBase64: Buffer.from("png").toString("base64") }],
      updatedAt: "2026-10-24T00:00:00.000Z",
    };
    expect(await host.syncDocs("ds1", [doc])).toBe(1);
    expect(uploaded.some((name) => name === "hx_doc1.md")).toBe(true);
    expect(uploaded.some((name) => name.includes("hx_doc1__"))).toBe(true);
    const hits = await host.searchKnowledge("ds1", "exp");
    expect(hits[0]?.docId).toBe("hx_doc1");
    expect(hits[0]?.assets[0]?.caption).toContain("过期时间");
    expect(await host.syncDocs("ds1", [doc])).toBe(0);

    const seen: string[] = [];
    const light = lightRagKnowledgeEngine({
      baseUrl: "http://lightrag.local",
      fetchImpl: async (input, init) => {
        const url = String(input);
        if (url.endsWith("/documents/text")) {
          const body = JSON.parse(String(init?.body)) as { text: string; file_source: string };
          seen.push(body.file_source);
          expect(body.text.startsWith(project({ ...doc, corpusId: "ds1", sha256: "x", indexState: "pending" }).slice(0, 7))).toBe(true);
          return json({ ok: true });
        }
        if (url.endsWith("/query")) {
          return json({ response: project({ ...doc, corpusId: "ds1", sha256: "x", indexState: "pending" }) });
        }
        if (init?.method === "DELETE") return json({ ok: true });
        return json({ error: url }, 404);
      },
    });
    expect(light.capabilities.images).toBe(false);
    expect(ragflow.capabilities.images).toBe(true);
    const host2 = createExternalHost({
      root: mkdtempSync(join(tmpdir(), "hx-light-")),
      memory: mem0MemoryEngine({ baseUrl: "http://mem0.local", fetchImpl: async () => json({ results: [] }) }),
      knowledge: light,
    });
    await host2.syncDocs("ds1", [{ ...doc, assets: [{ path: "docs/auth.png", caption: "右上角是过期时间" }] }]);
    const lightHits = await host2.searchKnowledge("ds1", "exp");
    expect(lightHits[0]?.docId).toBe("hx_doc1");
    expect(seen).toEqual(["hx_doc1"]);
  });
});
