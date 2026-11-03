// 无偏评测集 第 2 步 (词法版, 2026-11-03 22:25 改): 语义通道不可用 (query 嵌入只完成 380/420, 按用户指示放弃),
// 只跑 H0 = 现有混合 (BM25 + 词法向量 + 规则, purpose=recall, 线上实际形态, embedding source none)。朴素侧改为 judge_lex.py 内的 BM25 字 bigram baseline。
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
import { openMemoryStack } from "../../../../../src/app/stack.ts";
import { LexicalEmbedder } from "../../../../../src/retrieval/embedding-lexical.ts";
const corpus = JSON.parse(readFileSync(".tmp/bench/corpus-r2.json", "utf8")).entries as any[];
const meta = JSON.parse(readFileSync(".tmp/unbiased/meta.json", "utf8")) as Record<string, { at: number }>;
const qs = readFileSync(".tmp/unbiased/qpool.jsonl", "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
function hybrid() {
  const root = mkdtempSync(join(tmpdir(), "hx-unb-"));
  const st = openMemoryStack(root, { episodeRetentionDays: 0, autoEvolve: false, embedder: new LexicalEmbedder() });
  for (const e of corpus) st.store.add({ id: e.id, kind: e.kind, content: e.content, source: e.sourceRef, scope: e.scope, ...(e.project ? { project: e.project } : {}), ...(e.tags?.length ? { tags: e.tags } : {}), ...(e.entities?.length ? { entities: e.entities } : {}), ...(e.relations?.length ? { relations: e.relations.map((r: any) => ({ type: r.type, toId: r.to, ...(r.weight !== undefined ? { weight: r.weight } : {}) })) } : {}), ...(e.kind === "rule" ? { confirmedBy: "export", confirmedAt: e.assertedAt } : {}), ts: { validAt: e.validAt, assertedAt: e.assertedAt } } as any);
  st.retriever.warmSync();
  return { run: (q: string) => st.retriever.retrieveSync({ text: q, limit: 200, tokenBudget: 1e9, purpose: "recall" }).hits.map((x: any) => x.entry.id), close: () => { st.close(); rmSync(root, { recursive: true, force: true }); } };
}
const h0 = hybrid();
const out: any[] = [];
for (const q of qs) {
  const alive = (id: string) => (meta[id]?.at ?? 0) <= q.time;
  out.push({ qid: q.qid, H0: h0.run(q.text).filter(alive).slice(0, 50) });
}
h0.close();
writeFileSync(".tmp/unbiased/runs-lex.json", JSON.stringify(out));
console.log(JSON.stringify({ queries: out.length, avgH0: out.reduce((a, o) => a + o.H0.length, 0) / out.length }));
