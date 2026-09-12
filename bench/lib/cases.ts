// bench/lib/cases.ts — 生成评测 case (分层, gold 机器可验证)。
//
// 为什么分层: 单一类型的 case 会被某一种检索策略系统性主宰。词面探针偏爱 FTS,
// 语义改写偏爱向量, 多跳偏爱图。分层后能看出"某个系统的优势到底来自哪一层"。
//
// 分层与用途:
//   lexical_unique  — 全库唯一子串探针。天花板对照: 任何系统都该接近满分, 拉开差距说明有 bug。
//   lexical_shared  — 多条目共享的词面, 有区分度。
//   multihop        — 需要沿关系边扩展才能拿全的多个 gold。
//   temporal_update — 期望召回更新后的版本而不是旧版。
//   abstention      — 库里没有相关记忆, 期望弃权 (关键词经机器校验确实不出现)。
//
// 用法: node --experimental-strip-types bench/lib/cases.ts [--in corpus.json] [--out cases.json]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Corpus, CorpusEntry } from "./corpus.ts";

export interface Case {
  id: string;
  type: "lexical_unique" | "lexical_shared" | "multihop" | "temporal_update" | "abstention";
  query: string;
  expect: string[];
  secondary?: string[];
  note: string;
}

/** 在条目内容里找一段"只属于它"的子串 (高精度词面探针, 不依赖 LLM)。 */
export function uniqueProbe(text: string, others: string): string | null {
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

/** 保守的关键词出现判定: ASCII 词用词边界, 避免 "wal" 命中 "walk" 这类假泄漏。 */
export function mentions(haystack: string, term: string): boolean {
  const text = haystack.toLowerCase();
  const t = term.toLowerCase();
  if (/^[a-z ]+$/.test(t)) return new RegExp("(^|[^a-z])" + t + "([^a-z]|$)").test(text);
  return text.includes(t);
}

const ABSTAIN_TOPICS = [
  { q: "Rust 的 tokio 运行时怎么选", keys: ["tokio", "rust"] },
  { q: "Kubernetes 的 HPA 扩缩容阈值", keys: ["kubernetes", "hpa"] },
  { q: "MySQL 的 InnoDB 间隙锁怎么排查", keys: ["mysql", "innodb"] },
  { q: "iOS 的 SwiftUI 状态管理", keys: ["swiftui", "ios"] },
  { q: "CUDA 的 shared memory 优化", keys: ["cuda", "shared memory"] },
];

export function buildCases(corpus: Corpus): { schema: string; generatedAt: string; corpus: string; metrics: Record<string, string>; cases: Case[] } {
  const entries = corpus.entries;
  const cases: Case[] = [];
  let seq = 0;
  const nextId = (t: string): string => "c-" + t + "-" + String(++seq).padStart(4, "0");
  const haystackOf = (skipId: string): string =>
    entries.filter((e) => e.id !== skipId).map((e) => e.content).join("\n");

  // 1) 唯一子串探针 (天花板对照)
  for (const entry of entries) {
    if (entry.content.trim().length < 60) continue;
    const probe = uniqueProbe(entry.content, haystackOf(entry.id));
    if (!probe) continue;
    cases.push({
      id: nextId("lexical_unique"),
      type: "lexical_unique",
      query: probe,
      expect: [entry.id],
      note: "唯一子串: 天花板对照, 不应有区分度",
    });
  }

  // 2) 共享词面 (有区分度)
  const byWord = new Map<string, string[]>();
  for (const e of entries) {
    for (const w of e.content.split(/[\s,，。；;:：()（）]+/).filter((x) => x.length >= 4 && x.length <= 12)) {
      const list = byWord.get(w) ?? [];
      list.push(e.id);
      byWord.set(w, list);
    }
  }
  for (const [word, ids] of byWord) {
    if (ids.length < 3 || ids.length > 8) continue;
    cases.push({
      id: nextId("lexical_shared"),
      type: "lexical_shared",
      query: word,
      expect: ids.slice(0, 4),
      note: "共享词面命中 " + ids.length + " 条, 取前 4 条作 gold",
    });
  }

  // 3) 多跳 (真实关系边)
  const byId = new Map(entries.map((e) => [e.id, e]));
  for (const source of entries) {
    const targets = source.relations.map((r) => r.to).filter((id) => byId.has(id));
    if (!targets.length) continue;
    const probe = uniqueProbe(source.content, haystackOf(source.id));
    if (!probe) continue;
    cases.push({
      id: nextId("multihop"),
      type: "multihop",
      query: probe,
      expect: [source.id],
      secondary: targets.slice(0, 3),
      note: "主目标词面可命中; 次级目标只能靠关系边拿到",
    });
  }

  // 4) 时间更新 (supersedes 边)
  for (const e of entries) {
    for (const r of e.relations) {
      if (r.type !== "supersedes") continue;
      cases.push({
        id: nextId("temporal_update"),
        type: "temporal_update",
        query: uniqueProbe(e.content, haystackOf(e.id)) ?? e.content.slice(0, 20),
        expect: [e.id],
        note: "期望召回取代者而不是被取代者",
      });
    }
  }

  // 5) 弃权 (关键词机器校验确实不出现)
  const corpusText = entries.map((e) => e.content).join("\n");
  for (const item of ABSTAIN_TOPICS) {
    const leaked = item.keys.some((k) => mentions(corpusText, k));
    cases.push({
      id: nextId("abstention"),
      type: "abstention",
      query: item.q,
      expect: [],
      note: leaked ? "警告: 语料里出现了关键词, 需人工复核" : "语料中没有相关记忆, 期望弃权",
    });
  }

  return {
    schema: "hxmem-cases/1",
    generatedAt: new Date().toISOString(),
    corpus: "corpus.json",
    metrics: {
      "recall@k": "|top-k ∩ gold| / |gold| (gold 为空时不计入检索均值)",
      mrr: "首个 gold 的排名倒数",
      "ndcg@k": "二值相关 (IDCG = 把 |gold| 个 gold 排最前)",
      abstention: "系统返回空 OR top1 分数 < 阈值",
    },
    cases,
  };
}

function main(argv: string[]): number {
  let input = join(".tmp", "bench", "corpus.json");
  let out = join(".tmp", "bench", "cases.json");
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--in") input = argv[++i] ?? input;
    else if (argv[i] === "--out") out = argv[++i] ?? out;
  }
  const corpus = JSON.parse(readFileSync(input, "utf8")) as Corpus;
  const cases = buildCases(corpus);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(cases, null, 2));
  const byType: Record<string, number> = {};
  for (const c of cases.cases) byType[c.type] = (byType[c.type] ?? 0) + 1;
  console.log("case: " + cases.cases.length + " " + JSON.stringify(byType));
  console.log("输出: " + out);
  return 0;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "")) {
  process.exitCode = main(process.argv.slice(2));
}
