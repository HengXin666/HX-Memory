// 无偏评测集 第 2 步 (只读, 不改 src/): 对 qpool 每条 query 跑三路检索, 各取 top-50, 再剔除「query 时刻之后才写入」的条目。
//   N  朴素向量: Qwen3-Embedding-0.6B, 条目按 512 字切块取最大余弦 (与 bench/naive-vs-hybrid.ts 同算法、同向量缓存)
//   H0 现有混合 (BM25 + 词法向量 + 规则, purpose=recall), 线上实际形态
//   H1 现有混合 + 同一真语义嵌入器
// query 向量: .tmp/unbiased/qemb.jsonl (同模型离线嵌入, 与缓存逐位比对 cos=1.0000)
import { createHash } from "node:crypto"; import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
import { openMemoryStack } from "../../../../../src/app/stack.ts";
import { LexicalEmbedder } from "../../../../../src/retrieval/embedding-lexical.ts";
import type { SyncEmbedder } from "../../../../../src/kernel/ports.ts";
const corpus = JSON.parse(readFileSync(".tmp/bench/corpus-r2.json", "utf8")).entries as any[];
const meta = JSON.parse(readFileSync(".tmp/unbiased/meta.json", "utf8")) as Record<string, { at: number }>;
const qs = readFileSync(".tmp/unbiased/qpool.jsonl", "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const h = (t: string) => createHash("sha1").update(t).digest("hex");
const cache = new Map<string, number[]>();
for (const f of [".tmp/bench/emb-cache-Qwen3-Embedding-0.6B.jsonl", ".tmp/unbiased/qemb.jsonl"]) for (const l of readFileSync(f, "utf8").split("\n")) { if (!l) continue; try { const o = JSON.parse(l); cache.set(o.h, o.v); } catch {} }
const vec = (t: string) => { const v = cache.get(h(t)); if (!v) throw new Error("缺向量: " + t.slice(0, 30)); return v; };
const dot = (a: number[], b: number[]) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!; return s; };
const chunks = (t: string) => { const o: string[] = []; for (let i = 0; i < t.length; i += 512) o.push(t.slice(i, i + 512)); return o.length ? o : [""]; };
let miss = 0; const chunkIndex: { id: string; v: number[] }[] = [];
for (const e of corpus) for (const c of chunks(e.content)) { try { chunkIndex.push({ id: e.id, v: vec(c) }); } catch { miss++; } }
const naive = (q: string) => { const qv = vec(q), best = new Map<string, number>(); for (const c of chunkIndex) { const s = dot(qv, c.v); if (s > (best.get(c.id) ?? -9)) best.set(c.id, s); } return [...best].sort((a, b) => b[1] - a[1]).map((x) => x[0]); };
const dim = vec(qs[0].text).length;
const cached: SyncEmbedder = { id: "cached:Qwen3-Embedding-0.6B@" + dim, dim, floor: 0.3, embed: (ts: string[]) => ts.map(vec), embedSync: (ts: string[]) => ts.map(vec) } as any;
function hybrid(kind: "lexical" | "real") {
  const root = mkdtempSync(join(tmpdir(), "hx-unb-"));
  const st = openMemoryStack(root, { episodeRetentionDays: 0, autoEvolve: false, embedder: kind === "lexical" ? new LexicalEmbedder() : cached });
  for (const e of corpus) st.store.add({ id: e.id, kind: e.kind, content: e.content, source: e.sourceRef, scope: e.scope, ...(e.project ? { project: e.project } : {}), ...(e.tags?.length ? { tags: e.tags } : {}), ...(e.entities?.length ? { entities: e.entities } : {}), ...(e.relations?.length ? { relations: e.relations.map((r: any) => ({ type: r.type, toId: r.to, ...(r.weight !== undefined ? { weight: r.weight } : {}) })) } : {}), ...(e.kind === "rule" ? { confirmedBy: "export", confirmedAt: e.assertedAt } : {}), ts: { validAt: e.validAt, assertedAt: e.assertedAt } } as any);
  st.retriever.warmSync();
  return { run: (q: string) => st.retriever.retrieveSync({ text: q, limit: 200, tokenBudget: 1e9, purpose: "recall" }).hits.map((x: any) => x.entry.id), close: () => { st.close(); rmSync(root, { recursive: true, force: true }); } };
}
const h0 = hybrid("lexical"), h1 = hybrid("real");
const out: any[] = [];
for (const q of qs) {
  const alive = (id: string) => (meta[id]?.at ?? 0) <= q.time;
  out.push({ qid: q.qid, N: naive(q.text).filter(alive).slice(0, 50), H0: h0.run(q.text).filter(alive).slice(0, 50), H1: h1.run(q.text).filter(alive).slice(0, 50), alive: corpus.filter((e) => alive(e.id)).length });
}
h0.close(); h1.close();
writeFileSync(".tmp/unbiased/runs.json", JSON.stringify(out));
console.log(JSON.stringify({ queries: out.length, corpus: corpus.length, chunkMissing: miss, dim, avgH0: out.reduce((a, o) => a + o.H0.length, 0) / out.length }));
