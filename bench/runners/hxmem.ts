// bench/runners/hxmem.ts — 被测系统: 本仓库 (HX-Memory), 可切换通道组合。
//
// 为什么要跑多个变体: 单看"混合检索的分"无法回答"是哪个通道在起作用"。
// 变体矩阵把每个通道的边际贡献暴露出来 —— 本项目就是靠它发现"图扩展逐位无差别"
// 与"接入真语义反而显著变差"的。
//
// 用法:
//   node --experimental-strip-types bench/runners/hxmem.ts [--cases FILE] [--k N] [--out FILE]
//   HX_MEMORY_EMBEDDING_BASE_URL=http://127.0.0.1:4399/v1 ... (真语义变体需要本地嵌入服务)
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { openMemoryStack } from "../../src/app/stack.ts";
import { LexicalEmbedder } from "../../src/retrieval/embedding-lexical.ts";
import { OpenAiCompatibleEmbedder } from "../../src/retrieval/embedding-http.ts";
import type { Corpus } from "../lib/corpus.ts";

interface CaseFile {
  cases: Array<{ id: string; type: string; query: string; expect: string[]; secondary?: string[] }>;
}

interface Variant {
  label: string;
  embedder: "none" | "lexical" | "real";
  graph: 0 | 1;
}

const VARIANTS: Variant[] = [
  { label: "A 纯词面 (无向量/无图)", embedder: "none", graph: 0 },
  { label: "B 哈希近似语义", embedder: "lexical", graph: 0 },
  { label: "C 哈希语义 + 图扩展", embedder: "lexical", graph: 1 },
  { label: "D 真语义 (bge-small-zh)", embedder: "real", graph: 0 },
  { label: "E 真语义 + 图扩展", embedder: "real", graph: 1 },
];

function parseFlags(argv: string[]): {
  cases: string;
  k: number;
  out: string;
  corpus: string;
  budget: number;
} {
  const flags = {
    cases: join(".tmp", "bench", "cases.json"),
    corpus: join(".tmp", "bench", "corpus.json"),
    k: 10,
    out: join(".tmp", "bench", "hxmem-result.json"),
    // 默认给足预算: 评测要的是"排序能力", 不是"注入预算下的裁剪结果"。
    // 用默认 1200 会让返回条数被预算截断 (实测平均只回 9.0/10 条), 把裁剪噪声混进指标。
    budget: 1_000_000,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a === "--cases") flags.cases = argv[++i] ?? flags.cases;
    else if (a === "--corpus") flags.corpus = argv[++i] ?? flags.corpus;
    else if (a === "--k") flags.k = Number(argv[++i] ?? flags.k);
    else if (a === "--out") flags.out = argv[++i] ?? flags.out;
    else if (a === "--budget") flags.budget = Number(argv[++i] ?? flags.budget);
  }
  return flags;
}

async function main(): Promise<number> {
  const flags = parseFlags(process.argv.slice(2));
  const corpus = JSON.parse(readFileSync(flags.corpus, "utf8")) as Corpus;
  const caseFile = JSON.parse(readFileSync(flags.cases, "utf8")) as CaseFile;
  const results: Array<Record<string, unknown>> = [];

  for (const v of VARIANTS) {
    const root = mkdtempSync(join(tmpdir(), "hxmem-bench-"));
    const embedder =
      v.embedder === "none"
        ? null
        : v.embedder === "lexical"
          ? new LexicalEmbedder()
          : new OpenAiCompatibleEmbedder({
              baseUrl: process.env.HX_MEMORY_EMBEDDING_BASE_URL ?? "http://127.0.0.1:4399/v1",
              model: process.env.HX_MEMORY_EMBEDDING_MODEL ?? "bge-small-zh-v1.5",
              dim: Number(process.env.HX_MEMORY_EMBEDDING_DIM ?? 512),
            });
    const stack = openMemoryStack(root, {
      episodeRetentionDays: 0,
      ...(embedder ? { embedder } : { embedder: null }),
    });
    for (const e of corpus.entries) {
      stack.store.add({
        id: e.id,
        kind: e.kind as never,
        content: e.content,
        source: e.sourceRef,
        scope: e.scope as never,
        ...(e.project ? { project: e.project } : {}),
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
    // 异步嵌入器: 空索引本身就是 ready, 必须先 warm 一次把文档登记进队列, 再等补齐。
    if (v.embedder === "real") {
      for (let i = 0; i < 60; i++) {
        await stack.retriever.warm(2000);
        if (stack.retriever.ready()) break;
      }
    }

    const runs: Record<string, string[]> = {};
    const meta: Record<string, unknown> = {};
    for (const c of caseFile.cases) {
      // 查询向量也要 prime, 否则 retrieveSync 拿不到查询向量, 语义通道恒为空。
      if (v.embedder === "real") {
        for (let i = 0; i < 5; i++) {
          await stack.retriever.warm(2000, c.query);
          if (stack.retriever.ready()) break;
        }
      }
      const out = stack.retriever.retrieveSync({
        text: c.query,
        limit: flags.k,
        tokenBudget: flags.budget,
        purpose: "recall",
        expand: { graph: v.graph },
        ...(v.embedder === "none" ? { channels: { vector: { enabled: false } } } : {}),
      });
      runs[c.id] = out.hits.map((h) => h.entry.id);
      meta[c.id] = {
        top1: out.hits[0]?.entry.id ?? null,
        top1Score: Number((out.hits[0]?.score ?? 0).toFixed(4)),
        returned: out.hits.length,
        via: out.hits[0]?.channels ?? [],
        degraded: out.degraded,
      };
    }
    results.push({ variant: v.label, k: flags.k, runs, meta });
    console.error("完成变体: " + v.label);
    stack.close();
    rmSync(root, { recursive: true, force: true });
  }

  mkdirSync(dirname(flags.out), { recursive: true });
  writeFileSync(flags.out, JSON.stringify(results, null, 2));
  console.log("变体: " + results.length + " → " + flags.out);
  return 0;
}

process.exitCode = await main();
