// bench/naive-vs-hybrid.ts — 朴素基线对照: 纯向量 top-k vs 现有混合检索 (同一份语料, 同一批查询)。
//
// 为什么要它 (FIX-ROUND-2 A): 外部评测里「qwen 向量 (+重排)」打赢了所有花哨的记忆框架; 我们的分层 / 抽取 / 衰减 / 规则
// 从没和最笨的做法比过。没有这个对照, 不知道自己加的东西在帮忙还是帮倒忙。
//
// 变体 (同一份语料、同一批查询、同一个嵌入模型):
//   N  朴素基线: 记忆原文按 512 字切块 → 嵌入 → 余弦 → 按条目取最大块分 → top-k。不分层、不抽取、不衰减、不融合。
//   H0 现有混合检索, 按线上默认组装 (BM25 + LexicalEmbedder 词法向量 + 规则/实体通道, purpose=recall)。
//   H1 现有混合检索 + 同一个真语义嵌入器 (FIX-ROUND-2 C 接上之后的形态)。
// 指标: R@1 / R@5 / R@10 (= |topk ∩ gold| / |gold|), MRR@10 (首个 gold 名次的倒数, 10 名外记 0);
//       查询级 bootstrap 2000 次 95% 区间 (seed 固定), 以及 N − H0 / N − H1 的配对差区间。
//       另按「查询与 gold 正文的字 bigram 重合度」分两层报告 (<0.2 = 低重合, 字面检索的弱项)。
//
// 用法:
//   node --experimental-strip-types --no-warnings bench/naive-vs-hybrid.ts \
//     --corpus .tmp/bench/corpus-r2.json --cases .tmp/bench/cases-dialogue-r2.json [--k 10] [--out eval-out/naive-vs-hybrid.json]
// 嵌入端点: 环境变量 HX_MEMORY_EMBEDDING_* 或面板「模型 → 嵌入模型」(src/app/embedding-config.ts); 都没配 ⇒ 退出码 2 并说明怎么配。
// 向量缓存: .tmp/bench/emb-cache-<model>.jsonl (按 sha1(text) 记), 重跑不重复调接口。
// 退出码: 0 跑完; 2 未配置 / 参数错误; 3 嵌入接口出错。
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { openMemoryStack } from "../src/app/stack.ts";
import { embeddingSource } from "../src/app/embedding-config.ts";
import { LexicalEmbedder } from "../src/retrieval/embedding-lexical.ts";
import { OpenAiCompatibleEmbedder } from "../src/retrieval/embedding-http.ts";
import type { SyncEmbedder } from "../src/kernel/ports.ts";

const argv = process.argv.slice(2);
const opt = (k: string, d: string) => { const i = argv.indexOf("--" + k); return i >= 0 && argv[i + 1] ? argv[i + 1]! : d; };
const CORPUS = opt("corpus", ".tmp/bench/corpus-r2.json");
const CASES = opt("cases", ".tmp/bench/cases-dialogue-r2.json");
const K = Number(opt("k", "10"));
const OUT = opt("out", "eval-out/naive-vs-hybrid.json");
const BOOT = Number(opt("boot", "2000"));
const CHUNK = 512;

const src = embeddingSource(process.env);
if (src.source === "none") {
  console.error("嵌入模型未配置: 设环境变量 HX_MEMORY_EMBEDDING_BASE_URL / HX_MEMORY_EMBEDDING_MODEL (可选 _API_KEY), 或在面板「模型 → 嵌入模型」保存 base_url 与 model。");
  console.error("本机可起本地 Qwen 嵌入: HX_EMBED_MODEL=Qwen/Qwen3-Embedding-0.6B uv run --no-project --with fastembed python bench/serve/embed_server.py  (端点 http://127.0.0.1:4399/v1)");
  process.exit(2);
}
if (!existsSync(CORPUS) || !existsSync(CASES)) { console.error("缺语料或用例: " + CORPUS + " / " + CASES); process.exit(2); }

interface Entry { id: string; content: string; kind: string; scope: string; project: string | null; tags: string[]; entities: string[]; assertedAt: string; validAt: string; sourceRef: string; relations?: Array<{ type: string; to: string; weight?: number }> }
const corpus = (JSON.parse(readFileSync(CORPUS, "utf8")) as { entries: Entry[] }).entries;
const cases = (JSON.parse(readFileSync(CASES, "utf8")) as { cases: Array<{ id: string; query: string; expect: string[] }> }).cases.filter((c) => c.expect.length > 0);
const byId = new Map(corpus.map((e) => [e.id, e]));

// ---------- 嵌入 + 缓存 ----------
const remote = new OpenAiCompatibleEmbedder({ baseUrl: src.baseUrl, model: src.model, ...(src.key ? { apiKey: src.key } : {}), timeoutMs: 120_000, batchSize: 16 });
const cacheFile = join(".tmp", "bench", "emb-cache-" + src.model.replace(/[^A-Za-z0-9_.-]/g, "_") + ".jsonl");
mkdirSync(dirname(cacheFile), { recursive: true });
const cache = new Map<string, number[]>();
if (existsSync(cacheFile)) for (const l of readFileSync(cacheFile, "utf8").split("\n")) { if (!l) continue; try { const o = JSON.parse(l); cache.set(o.h, o.v); } catch { /* 坏行 */ } }
const h = (t: string) => createHash("sha1").update(t).digest("hex");
async function ensure(texts: string[]): Promise<void> {
  const todo = [...new Set(texts)].filter((t) => !cache.has(h(t)));
  for (let i = 0; i < todo.length; i += 32) {
    const batch = todo.slice(i, i + 32);
    const vs = await remote.embed(batch);
    batch.forEach((t, j) => { const v = l2(vs[j]!); cache.set(h(t), v); appendFileSync(cacheFile, JSON.stringify({ h: h(t), v }) + "\n"); });
    if ((i / 32) % 10 === 0) console.error(`  嵌入 ${Math.min(i + 32, todo.length)}/${todo.length}`);
  }
}
const l2 = (v: number[]) => { const n = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1; return v.map((x) => x / n); };
const vec = (t: string) => { const v = cache.get(h(t)); if (!v) throw new Error("缓存缺向量"); return v; };
const dot = (a: number[], b: number[]) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!; return s; };
const chunks = (t: string) => { const out: string[] = []; for (let i = 0; i < t.length; i += CHUNK) out.push(t.slice(i, i + CHUNK)); return out.length ? out : [""]; };

const t0 = Date.now();
try {
  await ensure([...corpus.flatMap((e) => chunks(e.content)), ...corpus.map((e) => e.content), ...cases.map((c) => c.query)]);
} catch (e) { console.error("嵌入接口出错: " + String(e)); process.exit(3); }
const dim = vec(cases[0]!.query).length;
console.error(`嵌入就绪: ${src.model} dim=${dim}, 缓存 ${cache.size} 条, ${Date.now() - t0} ms`);

// ---------- N 朴素基线 ----------
const chunkIndex = corpus.flatMap((e) => chunks(e.content).map((c) => ({ id: e.id, v: vec(c) })));
function naive(q: string): string[] {
  const qv = vec(q);
  const best = new Map<string, number>();
  for (const c of chunkIndex) { const s = dot(qv, c.v); if (s > (best.get(c.id) ?? -Infinity)) best.set(c.id, s); }
  return [...best.entries()].sort((a, b) => b[1] - a[1]).slice(0, K).map((x) => x[0]);
}

// ---------- H0 / H1 混合检索 ----------
const cached: SyncEmbedder = { id: "cached:" + src.model + "@" + dim, dim, floor: 0.3, embed: (ts) => ts.map(vec), embedSync: (ts) => ts.map(vec) };
function hybridRunner(embedder: "lexical" | "real"): { run: (q: string) => string[]; close: () => void } {
  const root = mkdtempSync(join(tmpdir(), "hx-naive-cmp-"));
  const stack = openMemoryStack(root, { episodeRetentionDays: 0, autoEvolve: false, embedder: embedder === "lexical" ? new LexicalEmbedder() : cached });
  for (const e of corpus) {
    stack.store.add({
      id: e.id, kind: e.kind as never, content: e.content, source: e.sourceRef, scope: e.scope as never,
      ...(e.project ? { project: e.project } : {}), ...(e.tags?.length ? { tags: e.tags } : {}), ...(e.entities?.length ? { entities: e.entities } : {}),
      ...(e.relations?.length ? { relations: e.relations.map((r) => ({ type: r.type as never, toId: r.to, ...(r.weight !== undefined ? { weight: r.weight } : {}) })) } : {}),
      ts: { validAt: e.validAt, assertedAt: e.assertedAt },
    });
  }
  stack.retriever.warmSync();
  return {
    run: (q) => stack.retriever.retrieveSync({ text: q, limit: K, tokenBudget: 1_000_000, purpose: "recall" }).hits.map((x) => x.entry.id).slice(0, K),
    close: () => { stack.close(); rmSync(root, { recursive: true, force: true }); },
  };
}

// ---------- 指标 ----------
interface Row { r1: number; r5: number; r10: number; mrr: number }
function score(ids: string[], gold: string[]): Row {
  const g = new Set(gold);
  const rk = (k: number) => ids.slice(0, k).filter((x) => g.has(x)).length / g.size;
  const first = ids.slice(0, 10).findIndex((x) => g.has(x));
  return { r1: rk(1), r5: rk(5), r10: rk(10), mrr: first < 0 ? 0 : 1 / (first + 1) };
}
let seed = 20261102;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
function boot(xs: number[]): [number, number] {
  const n = xs.length, ms: number[] = [];
  for (let b = 0; b < BOOT; b++) { let s = 0; for (let i = 0; i < n; i++) s += xs[Math.floor(rnd() * n)]!; ms.push(s / n); }
  ms.sort((a, b) => a - b);
  return [ms[Math.floor(0.025 * BOOT)]!, ms[Math.floor(0.975 * BOOT)]!];
}
const mean = (xs: number[]) => xs.reduce((a, x) => a + x, 0) / (xs.length || 1);
const bigrams = (t: string) => { const s = new Set<string>(); const x = t.replace(/\s+/g, ""); for (let i = 0; i + 2 <= x.length; i++) s.add(x.slice(i, i + 2)); return s; };
function overlap(q: string, gold: string[]): number {
  const qa = bigrams(q); let best = 0;
  for (const id of gold) { const gb = bigrams(byId.get(id)?.content ?? ""); let inter = 0; for (const b of qa) if (gb.has(b)) inter++; const u = qa.size + gb.size - inter; best = Math.max(best, u ? inter / u : 0); }
  return best;
}

const variants: Array<[string, (q: string) => string[], () => void]> = [["N 朴素向量 top-k", naive, () => undefined]];
const h0 = hybridRunner("lexical"); variants.push(["H0 现有混合 (BM25+词法向量+规则)", h0.run, h0.close]);
const h1 = hybridRunner("real"); variants.push(["H1 现有混合 + 真语义", h1.run, h1.close]);

const ov = cases.map((c) => overlap(c.query, c.expect));
const per: Record<string, Row[]> = {};
for (const [name, run, close] of variants) { per[name] = cases.map((c) => score(run(c.query), c.expect)); close(); }

const metrics = ["r1", "r5", "r10", "mrr"] as const;
function summarize(rows: Row[]) { return Object.fromEntries(metrics.map((m) => { const xs = rows.map((r) => r[m]); return [m, { mean: mean(xs), ci: boot(xs) }]; })); }
const strata = { all: cases.map((_, i) => i), lowOverlap: ov.map((o, i) => (o < 0.2 ? i : -1)).filter((i) => i >= 0), highOverlap: ov.map((o, i) => (o >= 0.2 ? i : -1)).filter((i) => i >= 0) };
const report: Record<string, unknown> = { generatedAt: new Date().toISOString(), embedding: { source: src.source, model: src.model, baseUrl: src.baseUrl, dim }, corpus: { file: CORPUS, n: corpus.length }, cases: { file: CASES, n: cases.length, lowOverlap: strata.lowOverlap.length, highOverlap: strata.highOverlap.length }, k: K, boot: BOOT, seed: 20261102, results: {} as Record<string, unknown>, paired: {} as Record<string, unknown> };
const names = variants.map((v) => v[0]);
const f = (x: number) => x.toFixed(3);
for (const [sname, idx] of Object.entries(strata)) {
  console.log(`\n== ${sname} (n=${idx.length})`);
  (report.results as Record<string, unknown>)[sname] = {};
  for (const n of names) {
    const s = summarize(idx.map((i) => per[n]![i]!));
    ((report.results as Record<string, Record<string, unknown>>)[sname]!)[n] = s;
    console.log(`${n.padEnd(28)} ` + metrics.map((m) => `${m.toUpperCase()} ${f(s[m]!.mean)} [${f(s[m]!.ci[0])}, ${f(s[m]!.ci[1])}]`).join("  "));
  }
  for (const other of names.slice(1)) {
    const d = Object.fromEntries(metrics.map((m) => { const xs = idx.map((i) => per[names[0]!]![i]![m] - per[other]![i]![m]); return [m, { mean: mean(xs), ci: boot(xs) }]; }));
    (report.paired as Record<string, unknown>)[sname + ": N − " + other] = d;
    console.log(`  N − ${other.split(" ")[0]}: ` + metrics.map((m) => `${m.toUpperCase()} ${f(d[m]!.mean)} [${f(d[m]!.ci[0])}, ${f(d[m]!.ci[1])}]`).join("  "));
  }
}
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(report, null, 2) + "\n");
console.log("\n产物 " + OUT);
process.exit(0);
