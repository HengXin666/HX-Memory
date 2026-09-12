// bench/lib/graph-cases.ts — 造"必须靠边才能答对"的 case, 用于公平衡量图扩展。
//
// 为什么需要 (这正是我上一轮缺的前提): 现有 171 个 case 的 gold 全部字面可命中,
// 因此图扩展召回次级目标时**无从加分** —— 用它判"图有没有用"是错的指标。
//
// 做法: 只在**语义承载型边**上造 case (generalizes / supersedes / contradicts / sameAs),
// 不用 relates (它只是共现, 精度实测 8.5%)。每条:
//   query = 从 A 内容里取的唯一探针 (字面只指向 A)
//   expect = [B]  (边另一端)
//   assert: B 的正文与 query **无字面重合** —— 否则它本来就能被词面召回, 不构成图专属 case
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Corpus, CorpusEntry } from "./corpus.ts";

const MEANINGFUL = new Set(["generalizes", "supersedes", "sameAs", "contradicts", "instanceOf"]);

/** 从 text 里取一段"只出现在这条里"的探针 (与 cases.ts 同口径)。 */
function uniqueProbe(text: string, others: string): string | null {
  const positions = [0.15, 0.4, 0.65, 0.9].map((p) => Math.floor(text.length * p));
  for (const start of positions) {
    for (let len = 20; len >= 6; len--) {
      const slice = text.slice(start, start + len).trim();
      if (slice.length < 6 || /\s/.test(slice) || /^[\p{P}\p{S}]+$/u.test(slice)) continue;
      if (others.includes(slice)) break;
      return slice;
    }
  }
  return null;
}

/** 字符 bigram 重合率 (判定"字面是否相关")。 */
function bigrams(s: string): Set<string> {
  const n = s.toLowerCase().replace(/[^0-9a-z\u4e00-\u9fff]+/g, "");
  const out = new Set<string>();
  for (let i = 0; i + 2 <= n.length; i++) out.add(n.slice(i, i + 2));
  return out;
}
function overlap(a: string, b: string): number {
  const x = bigrams(a), y = bigrams(b);
  if (!x.size || !y.size) return 0;
  let inter = 0;
  for (const t of x) if (y.has(t)) inter++;
  return inter / x.size;
}

function main(): number {
  const corpus = JSON.parse(readFileSync(join(".tmp", "bench", "corpus.json"), "utf8")) as Corpus;
  const byId = new Map<string, CorpusEntry>(corpus.entries.map((e) => [e.id, e]));
  const allText = corpus.entries.map((e) => e.content).join("\n");
  const cases: Array<Record<string, unknown>> = [];
  const rejected: string[] = [];

  for (const source of corpus.entries) {
    for (const rel of source.relations) {
      if (!MEANINGFUL.has(rel.type)) continue;
      const target = byId.get(rel.to);
      if (!target) continue;
      const probe = uniqueProbe(source.content, allText.replace(source.content, ""));
      if (!probe) { rejected.push(source.id + ": 无唯一探针"); continue; }
      // 关键前置条件: 目标与 query 必须字面不重合, 否则不构成"图专属"case
      const ov = overlap(probe, target.content);
      if (ov > 0.15) { rejected.push(source.id + "→" + target.id + ": 字面重合 " + ov.toFixed(2)); continue; }
      cases.push({
        id: "c-graphonly-" + String(cases.length).padStart(4, "0"),
        type: "graph_only",
        query: probe,
        expect: [target.id],
        seed: source.id,
        edge: rel.type,
        note: rel.type + " 边: query 字面只指向 seed, 目标需靠边才能拿到 (重合 " + ov.toFixed(2) + ")",
      });
    }
  }

  const out = join(".tmp", "bench", "cases-graph-only.json");
  writeFileSync(out, JSON.stringify({ schema: "hxmem-cases-graph/1", cases }, null, 2));
  console.log("graph_only case: " + cases.length + " 条 (拒绝 " + rejected.length + " 条 —— 字面重合或无可识别探针)");
  if (rejected.length) console.log("拒绝样例: " + rejected.slice(0, 5).join(" | "));
  console.log("输出: " + out);
  console.log("");
  console.log("读法: 这批 case 上, 图关闭时 expect 应当基本拿不到; 图开启时应当拿到 —— ");
  console.log("      这才是衡量图扩展的正确指标。");
  return 0;
}

process.exitCode = main();
