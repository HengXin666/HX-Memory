// bench/sample-subset.ts — 朴素基线对照的分层小样本 (2026-11-02: 全量 5021 段嵌入在 CPU 上要一小时, 用户选「砍小重跑」)。
//
// 规则 (写进产物 meta, 可复现):
//   1. 只取有 gold 的 case; 按「查询与 gold 正文的字 bigram Jaccard 最大值」分 low (<0.2) / high (>=0.2) 两层, 按原比例分配 --cases 个名额。
//   2. 层内按 seed 洗牌后依次收 case, 同时累计它的 gold; 收下这条后 gold 并集若超过 --corpus 就跳过它 (保证 gold 全在语料里)。
//   3. 语料 = 所有被收 case 的 gold ∪ 按 seed 从剩余条目里补足到 --corpus 条 (干扰项)。
//   4. 打印需要新嵌入的段数 (对照 .tmp/bench/emb-cache-<model>.jsonl), 先估时间再决定跑不跑。
// 用法: node --experimental-strip-types --no-warnings bench/sample-subset.ts [--cases 200] [--corpus 400] [--seed 20261102] [--model Qwen3-Embedding-0.6B]
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const opt = (k: string, d: string) => { const i = argv.indexOf("--" + k); return i >= 0 && argv[i + 1] ? argv[i + 1]! : d; };
const NC = Number(opt("cases", "200")), NK = Number(opt("corpus", "400")), SEED = Number(opt("seed", "20261102"));
const CORPUS = opt("in-corpus", ".tmp/bench/corpus-r2.json"), CASES = opt("in-cases", ".tmp/bench/cases-dialogue-r2.json");
const MODEL = opt("model", "Qwen3-Embedding-0.6B");
const corpusFile = JSON.parse(readFileSync(CORPUS, "utf8"));
const entries: Array<{ id: string; content: string }> = corpusFile.entries;
const byId = new Map(entries.map((e) => [e.id, e]));
const cases: Array<{ id: string; query: string; expect: string[] }> = JSON.parse(readFileSync(CASES, "utf8")).cases.filter((c: { expect: string[] }) => c.expect.length > 0 && c.expect.every((id) => byId.has(id)));
let s = SEED >>> 0;
const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
const shuffle = <T,>(xs: T[]) => { const a = [...xs]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j]!, a[i]!]; } return a; };
const bigrams = (t: string) => { const o = new Set<string>(); const x = t.replace(/\s+/g, ""); for (let i = 0; i + 2 <= x.length; i++) o.add(x.slice(i, i + 2)); return o; };
const overlap = (q: string, gold: string[]) => { const qa = bigrams(q); let best = 0; for (const id of gold) { const gb = bigrams(byId.get(id)!.content); let n = 0; for (const b of qa) if (gb.has(b)) n++; const u = qa.size + gb.size - n; best = Math.max(best, u ? n / u : 0); } return best; };
const low = cases.filter((c) => overlap(c.query, c.expect) < 0.2), high = cases.filter((c) => overlap(c.query, c.expect) >= 0.2);
const qLow = Math.round((NC * low.length) / cases.length), qHigh = NC - qLow;
const gold = new Set<string>();
const picked: typeof cases = [];
const fill = (pool: typeof cases, quota: number) => {
  let n = 0;
  for (const c of shuffle(pool)) {
    if (n >= quota) break;
    const add = c.expect.filter((id) => !gold.has(id));
    if (gold.size + add.length > NK) continue;
    add.forEach((id) => gold.add(id)); picked.push(c); n++;
  }
  return n;
};
const gotLow = fill(low, qLow), gotHigh = fill(high, qHigh);
const distract = shuffle(entries.filter((e) => !gold.has(e.id))).slice(0, Math.max(0, NK - gold.size));
const sub = [...entries.filter((e) => gold.has(e.id)), ...distract];
const meta = { seed: SEED, from: { corpus: CORPUS, cases: CASES, corpusN: entries.length, casesWithGold: cases.length }, strata: { lowOverlapAll: low.length, highOverlapAll: high.length, quotaLow: qLow, quotaHigh: qHigh, pickedLow: gotLow, pickedHigh: gotHigh }, corpus: { n: sub.length, gold: gold.size, distractors: distract.length } };
writeFileSync(".tmp/bench/corpus-r2-s" + NK + ".json", JSON.stringify({ ...corpusFile, entries: sub, sample: meta }, null, 0));
writeFileSync(".tmp/bench/cases-r2-s" + NC + ".json", JSON.stringify({ cases: picked, sample: meta }, null, 0));
// 需要新嵌入的段数
const cacheFile = ".tmp/bench/emb-cache-" + MODEL.replace(/[^A-Za-z0-9_.-]/g, "_") + ".jsonl";
const have = new Set<string>();
if (existsSync(cacheFile)) for (const l of readFileSync(cacheFile, "utf8").split("\n")) { const m = /"h":"([0-9a-f]{40})"/.exec(l); if (m) have.add(m[1]!); }
const h = (t: string) => createHash("sha1").update(t).digest("hex");
const chunks = (t: string) => { const o: string[] = []; for (let i = 0; i < t.length; i += 512) o.push(t.slice(i, i + 512)); return o.length ? o : [""]; };
const need = new Set([...sub.flatMap((e) => chunks(e.content)), ...sub.map((e) => e.content), ...picked.map((c) => c.query)]);
const missing = [...need].filter((t) => !have.has(h(t)));
console.log(JSON.stringify(meta));
console.log(`需嵌入 ${need.size} 段, 缓存已有 ${need.size - missing.length}, 新增 ${missing.length} 段 (缓存文件共 ${have.size} 条); 新增段平均 ${Math.round(missing.reduce((a, t) => a + t.length, 0) / (missing.length || 1))} 字`);
