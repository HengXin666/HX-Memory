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

  // ⚠ 2026-09-18 修三条硬伤 (见 docs/capture-audit §385 —— 那批 4 条 case 不可用):
  //   ① **同一个 query 三个不同 expect**: 旧版按 source 取探针, 于是同一 seed 的 5 条边
  //      产出 5 个**完全相同的 query** 却各带不同 expect。一个查询不可能同时以三条互为竞争
  //      关系的条目为"标准答案" ⇒ 现在**每个 seed 只取一个探针, 且该 seed 只产一条 case**。
  //   ② **超出补位配额**: seed 的语义边可达 5 条, 而 graphTierQuota = 3 ⇒ 必然有 2 条拿不到,
  //      那 2 条会把"没拿到"误记成"图通道失效"。⇒ 每 seed 上限 min(边数, GRAPH_TIER_QUOTA)。
  //   ③ **n 太小**: 语料本身只有 6 个源带语义边 (共 13 条), 所以上限就是 **10 条** ——
  //      这是**语料约束, 不是生成器的**。本文件只能做到"不浪费额度", 无法凭空造出样本。
  //      因此这批 case 的结论**只能当定向信号, 不能当统计依据** (n<10 时 1 条 = 10 个百分点)。
  //
  // ⚠⚠ **进一步核实后发现根因不可修 (2026-09-18, §388)**: 那些 seed 的正文只有 **19~41 字**,
  //   而探针只需 6 字 —— 于是**同一个探针必然同时适用于该 seed 的所有边目标**。
  //   这不是生成器的缺陷, 是**语料的性质**: 短条目无法为它指向的多个目标提供区分性查询。
  //   ⇒ 结论: **在当前语料上, "图通道"无法被单独可靠测量**。
  //      要真正评测它, 前提是**先有长正文的实例条目** (实例长、抽象短, 探针才落在实例上) ——
  //      而本仓库的语料恰好相反 (抽象规则短, 目标长)。这是一个**语料-指标错配**, 不是 bug。
  const GRAPH_TIER_QUOTA = 3;
  const MAX_PER_SEED = Math.min(3, GRAPH_TIER_QUOTA); // 保守取 3: 一条 query 最多对应一条 gold
  for (const source of corpus.entries) {
    const meaningful = source.relations.filter((r) => MEANINGFUL.has(r.type));
    if (!meaningful.length) continue;
    // 每 seed **只取一个**探针 (硬伤①的修法)
    const probe = uniqueProbe(source.content, allText.replace(source.content, ""));
    if (!probe) { rejected.push(source.id + ": 无唯一探针"); continue; }
    let used = 0;
    for (const rel of meaningful) {
      if (used >= MAX_PER_SEED) break; // 硬伤②的修法
      const target = byId.get(rel.to);
      if (!target) continue;
      // 关键前置条件: 目标与 query 必须字面不重合, 否则不构成"图专属"case
      const ov = overlap(probe, target.content);
      if (ov > 0.15) { rejected.push(source.id + "→" + target.id + ": 字面重合 " + ov.toFixed(2)); continue; }
      used++;
      cases.push({
        id: "c-graphonly-" + String(cases.length).padStart(4, "0"),
        type: "graph_only",
        query: probe,
        expect: [target.id],
        seed: source.id,
        edge: rel.type,
        // 同一 seed 的多条 case 共用一个 query ⇒ 它们**互为竞争关系**, 一起判才算公平。
        sibling: meaningful.length > 1,
        note: rel.type + " 边: query 字面只指向 seed, 目标需靠边才能拿到 (重合 " + ov.toFixed(2) +
          (meaningful.length > 1 ? "; 该 seed 共 " + meaningful.length + " 条语义边, 只用前 " + MAX_PER_SEED + " 条" : "") + ")",
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
