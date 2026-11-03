// 定性对比: 同一 query, 朴素向量 top-3 与现有混合 (H0: BM25+词法向量+规则, 与 bench 相同) top-3, 原文前 100 字 + 分数。
// 语料: .tmp/bench/corpus-r2.json (1287 条, 线上 active 记忆的导出)。向量复用 .tmp/bench/emb-cache-Qwen3-Embedding-0.6B.jsonl。
// 用法: HX_MEMORY_EMBEDDING_BASE_URL=http://127.0.0.1:4399/v1 HX_MEMORY_EMBEDDING_MODEL=Qwen3-Embedding-0.6B \
//   taskset -c 0-3 nice -n 19 node --experimental-strip-types --no-warnings bench/qualitative.ts
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemoryStack } from "../src/app/stack.ts";
import { embeddingSource } from "../src/app/embedding-config.ts";
import { LexicalEmbedder } from "../src/retrieval/embedding-lexical.ts";
import { OpenAiCompatibleEmbedder } from "../src/retrieval/embedding-http.ts";

const QUERIES = [
  ["q1 跨项目问规则", "之前定过的规则里, 关于提交前要不要跑测试是怎么说的"],
  ["q2 召回 lesson", "又忘了之前的教训, 同一个错误犯了第二次"],
  ["q3 事实检索", "WsPxy-colo HX-CF-WsPxy 用这个做出口可以吗？"],
];
const K = 3, CHUNK = 512;
const src = embeddingSource(process.env);
if (src.source === "none") { console.error("嵌入未配置"); process.exit(2); }
const corpus = (JSON.parse(readFileSync(".tmp/bench/corpus-r2.json", "utf8")) as { entries: any[] }).entries;
const byId = new Map(corpus.map((e) => [e.id, e]));
const cacheFile = ".tmp/bench/emb-cache-" + src.model.replace(/[^A-Za-z0-9_.-]/g, "_") + ".jsonl";
const cache = new Map<string, number[]>();
if (existsSync(cacheFile)) for (const l of readFileSync(cacheFile, "utf8").split("\n")) { if (!l) continue; try { const o = JSON.parse(l); cache.set(o.h, o.v); } catch {} }
const h = (t: string) => createHash("sha1").update(t).digest("hex");
const l2 = (v: number[]) => { const n = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1; return v.map((x) => x / n); };
const chunks = (t: string) => { const o: string[] = []; for (let i = 0; i < t.length; i += CHUNK) o.push(t.slice(i, i + CHUNK)); return o.length ? o : [""]; };
const remote = new OpenAiCompatibleEmbedder({ baseUrl: src.baseUrl, model: src.model, ...(src.key ? { apiKey: src.key } : {}), timeoutMs: 600_000, batchSize: 4 });
const need = [...new Set([...corpus.flatMap((e) => chunks(e.content)), ...QUERIES.map((q) => q[1]!)])].filter((t) => !cache.has(h(t)));
console.error(`缓存 ${cache.size} 条, 需新嵌入 ${need.length} 段`);
for (let i = 0; i < need.length; i += 4) { const b = need.slice(i, i + 4); const vs = await remote.embed(b); b.forEach((t, j) => { const v = l2(vs[j]!); cache.set(h(t), v); appendFileSync(cacheFile, JSON.stringify({ h: h(t), v }) + "\n"); }); }
const dot = (a: number[], b: number[]) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!; return s; };
const idx = corpus.flatMap((e) => chunks(e.content).map((c) => ({ id: e.id, v: cache.get(h(c))! })));
function naive(q: string) { const qv = cache.get(h(q))!; const best = new Map<string, number>(); for (const c of idx) { const s = dot(qv, c.v); if (s > (best.get(c.id) ?? -Infinity)) best.set(c.id, s); } return [...best.entries()].sort((a, b) => b[1] - a[1]).slice(0, K); }

const root = mkdtempSync(join(tmpdir(), "hx-qual-"));
const stack = openMemoryStack(root, { episodeRetentionDays: 0, autoEvolve: false, embedder: new LexicalEmbedder() });
for (const e of corpus) stack.store.add({ id: e.id, kind: e.kind, content: e.content, source: e.sourceRef, scope: e.scope, ...(e.project ? { project: e.project } : {}), ...(e.tags?.length ? { tags: e.tags } : {}), ...(e.entities?.length ? { entities: e.entities } : {}), ...(e.relations?.length ? { relations: e.relations.map((r: any) => ({ type: r.type, toId: r.to, ...(r.weight !== undefined ? { weight: r.weight } : {}) })) } : {}), ...(e.confirmedBy ? { confirmedBy: e.confirmedBy, confirmedAt: e.confirmedAt } : e.kind === "rule" ? { confirmedBy: "export", confirmedAt: e.assertedAt } : {}), ts: { validAt: e.validAt, assertedAt: e.assertedAt } } as never);
stack.retriever.warmSync();
const out: any[] = [];
const show = (e: any) => `${e.kind} | ${e.project ?? "-"} | ${String(e.content).replace(/\s+/g, " ").slice(0, 100)}`;
for (const [tag, q] of QUERIES) {
  console.log(`\n### ${tag}: 「${q}」`);
  const a = naive(q!); console.log("A 朴素向量 top-3 (分数=cosine):");
  a.forEach(([id, s], i) => console.log(`  A${i + 1} ${s.toFixed(4)} | ${show(byId.get(id))}`));
  const b = stack.retriever.retrieveSync({ text: q!, limit: K, purpose: "recall" }).hits.slice(0, K);
  console.log("B 现有 hybrid top-3 (分数=retriever score):");
  if (!b.length) console.log("  (空)");
  b.forEach((x: any, i: number) => console.log(`  B${i + 1} ${Number(x.score ?? x.finalScore ?? NaN).toFixed(4)} | ${show(byId.get(x.entry.id) ?? x.entry)}`));
  out.push({ tag, q, A: a.map(([id, s]) => ({ id, s, ...byId.get(id) })), B: b.map((x: any) => ({ id: x.entry.id, s: x.score ?? x.finalScore, kind: x.entry.kind, content: x.entry.content, project: x.entry.project })) });
}
writeFileSync("eval-out/qualitative.json", JSON.stringify(out, null, 1));
stack.close(); rmSync(root, { recursive: true, force: true });
