// scripts/eval/kb-retrieval.ts — EVAL.md K1 (博客命中率 Hit@5) / K2 (排序质量 MRR@10)。
//
// 查询集: tests/fixtures/eval/kb-queries.jsonl, 120 条, 按 EVAL 2.2 分三类各 40:
//   title  标题改写类 (问法不同于标题);  detail 正文细节类 (答案在某个 `##` 小节里, 行内带 section);
//   cross  跨篇类 (expect_paths 有 2 篇或以上)。
// 名额按三个目录的文件数比例分配 (最大余数法), 语料 = walkMarkdown(blog/ ai-docs/ docs/), 与 K3 同一口径
// (不含隐藏目录、隐藏文件、node_modules; draft: true 和正文为空的占位文件不抽)。
//
// 问题必须由人写 (EVAL 2.2: 不用 LLM 从原文生成, 避免用词和原文相同把字面检索抬高)。所以本脚本分两步:
//   --make-slots  只做确定性的分层抽样, 写出 120 个「槽位」: 类别、期望文件、(detail 类) 期望小节, question 留空;
//   (默认)        评测: 任何一条 question 为空就拒绝打分 (退出码 2), 不拿占位问题算出一个好看的数。
// 抽样确定性: 每个候选按 fnv1a(类别 + ":" + 相对路径) 排序取前 N, 与文件系统遍历顺序无关。
//
// 用法:
//   node --experimental-strip-types --no-warnings scripts/eval/kb-retrieval.ts --make-slots --src <博客根> [--force]
//   node --experimental-strip-types --no-warnings scripts/eval/kb-retrieval.ts --src <博客根> [--out eval-out]
// 退出码: 0 K1 >= 0.80 且 K2 >= 0.60 (或 --make-slots 写出); 1 未达标; 2 参数错误 / 查询集不完整 / 拒绝覆盖已写问题; 3 运行出错。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_KB_DIRS, KbSync, walkMarkdown } from "../../src/kb/kb-sync.ts";
import { openMemoryStack } from "../../src/app/stack.ts";
import { fnv1a } from "../../src/frustration/features.ts";
import { writeReport } from "./report.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const arg = (n: string) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };
const QUERIES = resolve(REPO, arg("--queries") ?? "tests/fixtures/eval/kb-queries.jsonl");
const PER_CLASS = 40;

export interface KbQuery {
  qid: string;
  kind: "title" | "detail" | "cross";
  dir: string;
  expect_paths: string[];
  section?: string;
  question: string;
  author: string;
}

/** 最大余数法: 按各目录文件数分配 total 个名额。 */
export function quotas(counts: Record<string, number>, total: number): Record<string, number> {
  const sum = Object.values(counts).reduce((a, b) => a + b, 0);
  const raw = Object.entries(counts).map(([k, n]) => ({ k, q: (total * n) / sum }));
  const out = Object.fromEntries(raw.map((r) => [r.k, Math.floor(r.q)]));
  let left = total - Object.values(out).reduce((a, b) => a + b, 0);
  for (const r of [...raw].sort((a, b) => (b.q % 1) - (a.q % 1) || a.k.localeCompare(b.k))) if (left-- > 0) out[r.k]!++;
  return out;
}

function makeSlots(src: string): number {
  if (existsSync(QUERIES) && !process.argv.includes("--force")) {
    const filled = readFileSync(QUERIES, "utf8").split("\n").filter((l) => l.trim()).filter((l) => JSON.parse(l).question?.trim()).length;
    if (filled) { console.error(`${QUERIES} 已有 ${filled} 条人写问题, 拒绝覆盖 (确需重抽加 --force)`); return 2; }
  }
  const files = walkMarkdown(src, DEFAULT_KB_DIRS).map((f) => relative(src, f).split("\\").join("/"));
  const info = new Map<string, { draft: boolean; empty: boolean; h2: string[] }>();
  for (const f of files) {
    const raw = readFileSync(join(src, f), "utf8");
    const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
    const body = fm ? raw.slice(fm[0].length) : raw;
    info.set(f, {
      draft: /^draft:\s*true\s*$/m.test(fm?.[1] ?? ""),
      empty: body.replace(/\s+/g, "").length < 50,
      h2: [...body.matchAll(/^##\s+(.+?)\s*$/gm)].map((m) => m[1]!),
    });
  }
  const usable = files.filter((f) => !info.get(f)!.draft && !info.get(f)!.empty);
  const top = (f: string) => f.split("/")[0]!;
  const counts = Object.fromEntries(DEFAULT_KB_DIRS.map((d) => [d, files.filter((f) => top(f) === d).length]));
  const q = quotas(counts, PER_CLASS);
  const order = (kind: string, xs: string[]) => [...xs].sort((a, b) => fnv1a(kind + ":" + a) - fnv1a(kind + ":" + b) || a.localeCompare(b));
  const used = new Set<string>();
  const slots: KbQuery[] = [];
  for (const kind of ["title", "detail", "cross"] as const) {
    for (const d of DEFAULT_KB_DIRS) {
      let pool = order(kind, usable.filter((f) => top(f) === d && !used.has(f)));
      if (kind === "detail") pool = pool.filter((f) => info.get(f)!.h2.length > 0);
      let n = 0;
      for (const f of pool) {
        if (n >= q[d]!) break;
        const slot: KbQuery = { qid: "", kind, dir: d, expect_paths: [f], question: "", author: "" };
        if (kind === "detail") { const h = info.get(f)!.h2; slot.section = h[fnv1a("sec:" + f) % h.length]; }
        if (kind === "cross") {
          // 搭档: 离锚点最近的另一篇 (同一系列): 先找同一父目录, 再找同一祖父目录 (docs/ 下多为「一篇一个目录 + index.md」),
          // 再上一层; 都没有就跳过这个锚点。搭档不再被其他槽位重复用作期望文件。
          const up = (x: string, k: number) => { let d = dirname(x); for (let i = 0; i < k; i++) d = dirname(d); return d; };
          let mate: string | undefined;
          for (let k = 0; k <= 2 && !mate; k++) {
            const base = up(f, k);
            if (base === d || base === ".") break;
            mate = order("mate:" + f, usable.filter((g) => g !== f && !used.has(g) && g.startsWith(base + "/")))[0];
          }
          if (!mate) continue;
          slot.expect_paths.push(mate);
          used.add(mate);
        }
        used.add(f);
        slots.push(slot);
        n++;
      }
    }
  }
  slots.forEach((s, i) => (s.qid = "k" + String(i + 1).padStart(3, "0")));
  mkdirSync(dirname(QUERIES), { recursive: true });
  writeFileSync(QUERIES, slots.map((s) => JSON.stringify(s)).join("\n") + "\n");
  const by = (k: string) => slots.filter((s) => s.kind === k).length;
  console.log(`槽位 ${slots.length} 条 (title ${by("title")}, detail ${by("detail")}, cross ${by("cross")}); 名额 ${JSON.stringify(q)} / 类`);
  console.log(`语料 ${files.length} 篇 (${JSON.stringify(counts)}), 可抽 ${usable.length} 篇 (排除 draft ${files.filter((f) => info.get(f)!.draft).length}, 空占位 ${files.filter((f) => info.get(f)!.empty).length})`);
  console.log(`写出 ${relative(REPO, QUERIES)}; question 全部留空, 由人填写后再跑评测`);
  return 0;
}

function evaluate(src: string, outDir: string): number {
  if (!existsSync(QUERIES)) { console.error("缺少查询集 " + QUERIES + " (先 --make-slots)"); return 2; }
  const qs: KbQuery[] = readFileSync(QUERIES, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  const empty = qs.filter((x) => !x.question?.trim());
  if (empty.length) {
    console.error(`查询集 ${qs.length} 条, 其中 ${empty.length} 条 question 为空; EVAL 2.2 要求人写问题, 拒绝打分`);
    console.error("空槽位前 3 个: " + empty.slice(0, 3).map((x) => `${x.qid}(${x.kind}) ${x.expect_paths.join(" + ")}${x.section ? " § " + x.section : ""}`).join("; "));
    console.error("K1/K2 = 未测");
    return 2;
  }
  const mem = mkdtempSync(join(tmpdir(), "kb-k12-"));
  const stack = openMemoryStack(mem, { episodeRetentionDays: 0, embedder: null });
  try {
    new KbSync({ store: stack.store as never, root: src }).syncOnce();
    const rows = qs.map((x) => {
      const res = stack.retriever.retrieveSync({ text: x.question, purpose: "recall", kinds: ["doc"], limit: 10 });
      const paths = res.hits.map((h) => String(h.entry.source ?? "").replace(/^kb:/, ""));
      const rank = paths.findIndex((p) => x.expect_paths.includes(p)) + 1;
      const secHit = x.section ? res.hits.slice(0, 5).some((h) => x.expect_paths.includes(String(h.entry.source).replace(/^kb:/, "")) && String((h.entry as { content?: string }).content ?? "").includes("/ " + x.section)) : null;
      return { qid: x.qid, kind: x.kind, rank, hit5: rank > 0 && rank <= 5, rr: rank > 0 ? 1 / rank : 0, sectionHit: secHit, top: paths.slice(0, 5) };
    });
    const k1 = rows.filter((r) => r.hit5).length / rows.length;
    const k2 = rows.reduce((a, r) => a + r.rr, 0) / rows.length;
    const byKind = Object.fromEntries(["title", "detail", "cross"].map((k) => { const rs = rows.filter((r) => r.kind === k); return [k, { n: rs.length, hit5: rs.filter((r) => r.hit5).length, mrr: rs.reduce((a, r) => a + r.rr, 0) / (rs.length || 1) }]; }));
    mkdirSync(outDir, { recursive: true });
    const at = new Date().toISOString();
    writeFileSync(join(outDir, "K1.json"), JSON.stringify({ metric: "K1", value: k1, threshold: 0.8, n: rows.length, pass: k1 >= 0.8, byKind, at, rows }, null, 2) + "\n");
    writeFileSync(join(outDir, "K2.json"), JSON.stringify({ metric: "K2", value: k2, threshold: 0.6, n: rows.length, pass: k2 >= 0.6, byKind, at }, null, 2) + "\n");
    console.log(`K1 Hit@5=${k1.toFixed(4)}  K2 MRR@10=${k2.toFixed(4)}  (n=${rows.length})`);
    writeReport(REPO);
    return k1 >= 0.8 && k2 >= 0.6 ? 0 : 1;
  } finally {
    stack.close();
    rmSync(mem, { recursive: true, force: true });
  }
}

if (import.meta.url === "file://" + process.argv[1]) {
  try {
    const src = arg("--src");
    if (!src || !existsSync(src)) { console.error("用法: kb-retrieval.ts [--make-slots] --src <博客根>"); process.exitCode = 2; }
    else process.exitCode = process.argv.includes("--make-slots") ? makeSlots(src) : evaluate(src, resolve(REPO, arg("--out") ?? "eval-out"));
  } catch (e) {
    console.error(e);
    process.exitCode = 3;
  }
}
