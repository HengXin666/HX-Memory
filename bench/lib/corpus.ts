// bench/lib/corpus.ts — 从真实库只读导出**中立语料** (与任何宿主/引擎无关的最小字段集)。
//
// 为什么独立成文件: 语料是全部被测系统的共同输入, 它的字段集一旦偏向某个系统的内部模型,
// 比较就失去意义。因此这里只导出"任何记忆系统都必须能表达"的字段。
//
// 隐私: 产物含真实记忆原文, 默认写到 .tmp/bench/ (gitignore 内), 永远不要提交。
// 用法: node --experimental-strip-types bench/lib/corpus.ts [--root DIR] [--out FILE]
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { scanTruth } from "../../src/storage/truth-scan.ts";

export interface CorpusEntry {
  id: string;
  content: string;
  kind: string;
  scope: string;
  project: string | null;
  tags: string[];
  entities: string[];
  assertedAt: string;
  validAt: string;
  sourceRef: string;
  confirmed: boolean;
  confirmedBy: string | null;
  confirmedAt: string | null;
  relations: Array<{ type: string; to: string; weight: number }>;
}

export interface Corpus {
  schema: "hxmem-corpus/1";
  exportedAt: string;
  source: { system: string; root: string; count: number; droppedShadow: number };
  entries: CorpusEntry[];
}

const ROOT = join(homedir(), ".dsh", "hx-memory");

export function buildCorpus(root: string): Corpus {
  const { entries } = scanTruth(root);
  const all = [...entries.values()];
  const active = all.filter((e) => (e.status ?? "active") !== "shadow");
  return {
    schema: "hxmem-corpus/1",
    exportedAt: new Date().toISOString(),
    source: {
      system: "HX-Memory",
      root,
      count: active.length,
      droppedShadow: all.length - active.length,
    },
    entries: active.map((e) => ({
      id: e.id,
      content: e.content,
      kind: e.kind,
      scope: e.scope,
      project: e.project ?? null,
      tags: e.tags ?? [],
      entities: e.entities ?? [],
      assertedAt: e.ts.assertedAt,
      validAt: e.ts.validAt,
      sourceRef: e.source,
      confirmed: Boolean(e.confirmedBy),
      confirmedBy: e.confirmedBy ?? null,
      confirmedAt: e.confirmedAt ?? null,
      relations: (e.relations ?? []).map((r) => ({
        type: r.type,
        to: r.toId,
        weight: r.weight ?? 0,
      })),
    })),
  };
}

function main(argv: string[]): number {
  let root = ROOT;
  let out = join(".tmp", "bench", "corpus.json");
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (arg === "--root") root = (argv[++i] ?? root).replace(/^~/, homedir());
    else if (arg === "--out") out = argv[++i] ?? out;
  }
  const corpus = buildCorpus(root);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(corpus, null, 2));
  console.log("语料: " + corpus.entries.length + " 条 (排除 shadow " + corpus.source.droppedShadow + ")");
  console.log("输出: " + out);
  return 0;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "")) {
  process.exitCode = main(process.argv.slice(2));
}
