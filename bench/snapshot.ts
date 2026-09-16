// bench/snapshot.ts — 指标快照: 把关键评测数字固化成文件, 由 CI 比对防漂移。
//
// 为什么需要它: docs/memory-benchmark-report.md 里的表格是**手抄**的。检索逻辑一改,
// 报告不会自动更新 —— 数字会静默过期, 而"过期但看起来权威"比没有报告更糟。
// 本脚本把关键指标写成 JSON 快照; verify-bench-snapshot 比对当前实现与快照的偏差,
// 超阈值就失败, 强迫"改行为"与"改报告"在同一提交里发生 (与 verify-docs 同一思路)。
//
// 用法:
//   node --experimental-strip-types bench/snapshot.ts --write    # 写快照
//   node --experimental-strip-types bench/snapshot.ts --check    # 比对 (CI)
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemoryStack } from "../src/app/stack.ts";
import { LexicalEmbedder } from "../src/retrieval/embedding-lexical.ts";
import type { Corpus } from "./lib/corpus.ts";

const HERE = import.meta.dirname;
const SNAPSHOT = join(HERE, "snapshot.json");
const CORPUS = join(".tmp", "bench", "corpus.json");
const CASES = join(".tmp", "bench", "cases.json");
const K = 10;
/** 允许的偏差: 指标是浮点且依赖分词/排序细节, 留一点余量; 超过说明行为变了。 */
const TOLERANCE = 0.005;

interface CaseFile {
  cases: Array<{ id: string; type: string; query: string; expect: string[] }>;
}

function recallAt(ranked: string[], gold: Set<string>, k: number): number {
  return gold.size ? ranked.slice(0, k).filter((x) => gold.has(x)).length / gold.size : 0;
}

/**
 * 语料的内容指纹 (不含 exportedAt / source.root 这类每次导出都会变的元数据)。
 *
 * 为什么要它: 快照的指标同时受**代码**与**输入语料**影响, 而语料在 gitignore 里 ——
 * 它是本机真实记忆的导出, 会随使用而变化。没有指纹时, 两种情况都只能报"指标漂移",
 * 而它们的处置完全相反: 语料变了要重新导出快照, 代码变了要解释清楚改了什么。
 */
function corpusFingerprint(corpus: Corpus): string {
  // 只取参与检索的字段, 且排序固定 (导出顺序不该影响身份)。
  const canonical = corpus.entries
    .map((e) => [e.id, e.content, e.kind, e.scope, e.project ?? "", e.entities.join(","), e.relations.map((r) => r.type + ">" + r.to + ":" + r.weight).join(",")].join("\u0000"))
    .sort()
    .join("\u0001");
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

/** 只保留**与远端系统无关**的臂: 本仓库的确定性变体 (不依赖 LLM/嵌入服务), CI 才能跑。 */
function measure(corpus: Corpus, cases: CaseFile): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [label, embedder] of [
    ["A 纯词面", null],
    ["B 哈希近似语义", new LexicalEmbedder()],
  ] as const) {
    const root = mkdtempSync(join(tmpdir(), "hxmem-snap-"));
    const stack = openMemoryStack(root, {
      episodeRetentionDays: 0,
      ...(embedder ? { embedder } : { embedder: null }),
    });
    for (const e of corpus.entries) {
      stack.store.add({
        id: e.id, kind: e.kind as never, content: e.content, source: e.sourceRef,
        scope: e.scope as never, ...(e.project ? { project: e.project } : {}),
        ...(e.tags.length ? { tags: e.tags } : {}),
        ...(e.entities.length ? { entities: e.entities } : {}),
        ...(e.relations.length
          ? { relations: e.relations.map((r) => ({ type: r.type as never, toId: r.to, weight: r.weight })) }
          : {}),
        ...(e.confirmedBy
          ? { confirmedBy: e.confirmedBy, ...(e.confirmedAt ? { confirmedAt: e.confirmedAt } : {}) }
          : {}),
        ts: { validAt: e.validAt, assertedAt: e.assertedAt },
      });
    }
    let r1 = 0, r10 = 0, h10 = 0, n = 0;
    for (const c of cases.cases) {
      if (!c.expect.length) continue;
      const gold = new Set(c.expect);
      const res = stack.retriever.retrieveSync({
        text: c.query, limit: K, tokenBudget: 1_000_000, purpose: "recall",
        ...(embedder ? {} : { channels: { vector: { enabled: false } } }),
      });
      const ids = res.hits.map((h) => h.entry.id);
      r1 += recallAt(ids, gold, 1);
      r10 += recallAt(ids, gold, K);
      if (ids.slice(0, K).some((x) => gold.has(x))) h10++;
      n++;
    }
    out[label + " R@1"] = Number((r1 / n).toFixed(4));
    out[label + " R@10"] = Number((r10 / n).toFixed(4));
    out[label + " H@10"] = Number((h10 / n).toFixed(4));
    stack.close();
    rmSync(root, { recursive: true, force: true });
  }
  // 结构完整性: 这些不依赖服务, 也应由 CI 守住
  out["语料条目数"] = corpus.entries.length;
  out["关系边总数"] = corpus.entries.reduce((s, e) => s + e.relations.length, 0);
  out["有 entities 的条目"] = corpus.entries.filter((e) => e.entities.length).length;
  return out;
}

function main(): number {
  // 语料来自真实记忆库, 含私人内容, 永不入库 (在 gitignore 的 .tmp/ 下)。
  // 因此在没有它的环境 (CI / 新克隆) 必须**明确跳过而不是假装通过** ——
  // 这条 gate 的适用范围只写进 Agent Note, 不靠"大家记得"。
  if (!existsSync(CORPUS) || !existsSync(CASES)) {
    console.log("bench-snapshot: 跳过 (缺 " + CORPUS + " —— 该语料含真实记忆, 不入库)。");
    console.log("  本地首次使用: node --experimental-strip-types bench/lib/corpus.ts");
    return 0;
  }
  const corpus = JSON.parse(readFileSync(CORPUS, "utf8")) as Corpus;
  // 快照断言的是**某一份语料上**的指标, 所以必须先判"是不是同一份语料" —— 否则漂移
  // 红得没有解释力: 实测把 HEAD 与它的父提交各跑一次, 数字一模一样 (都是 0.635),
  // 而快照里记的是 0.6411。缺了这一步, 人只能靠猜"是代码变了还是语料变了"。
  const fingerprint = corpusFingerprint(corpus);
  if (!existsSync(SNAPSHOT)) {
    console.error("bench-snapshot: 缺少快照文件 " + SNAPSHOT);
    return 1;
  }
  const cases = JSON.parse(readFileSync(CASES, "utf8")) as CaseFile;
  const now = measure(corpus, cases);

  if (process.argv.includes("--write")) {
    const snapshot = { k: K, tolerance: TOLERANCE, corpus: fingerprint, metrics: now };
    writeFileSync(SNAPSHOT, JSON.stringify(snapshot, null, 2) + "\n");
    console.log("快照已写入: " + SNAPSHOT + " (语料指纹 " + fingerprint + ")");
    for (const [k, v] of Object.entries(now)) console.log("  " + k.padEnd(26) + v);
    return 0;
  }

  const saved = JSON.parse(readFileSync(SNAPSHOT, "utf8")) as {
    metrics: Record<string, number>;
    tolerance?: number;
    corpus?: string;
  };
  // 语料身份对不上 → 这不是"实现漂移", 是"输入换了"。两者处置相反, 必须分开报:
  // 混在一起说"指标漂移", 人就只能猜到累了为止 (实测这个 gate 从诞生起就一直这么红)。
  if (saved.corpus !== undefined && saved.corpus !== fingerprint) {
    console.error("bench-snapshot: 语料已变 (快照记的是 " + saved.corpus + ", 当前是 " + fingerprint + ")。");
    console.error("  指标差异可能全部来自输入而不是实现。要在这份语料上继续用, 重新导出快照:");
    console.error("    node --experimental-strip-types bench/snapshot.ts --write");
    console.error("  若确实实现了行为变更, 同一次提交里也要同步 docs/memory-benchmark-report.md 的表格。");
    return 1;
  }
  const tol = saved.tolerance ?? TOLERANCE;
  const drift: string[] = [];
  for (const [key, was] of Object.entries(saved.metrics)) {
    const is = now[key];
    if (is === undefined) { drift.push(key + ": 快照有但当前指标缺失"); continue; }
    if (Math.abs(is - was) > tol) drift.push(key + ": " + was + " → " + is);
  }
  if (drift.length) {
    console.error("bench-snapshot: 指标漂移超过 " + tol + ":");
    for (const d of drift) console.error("  " + d);
    console.error("");
    console.error("若这是**有意**的行为变更: 在同一次提交里跑");
    console.error("  node --experimental-strip-types bench/snapshot.ts --write");
    console.error("并同步更新 docs/memory-benchmark-report.md 的表格。");
    return 1;
  }
  console.log("bench-snapshot: " + Object.keys(saved.metrics).length + " 项指标与快照一致 (容差 " + tol + ")");
  return 0;
}

process.exitCode = main();
