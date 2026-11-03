// scripts/eval/k1k2-score.ts — K1 (Hit@5) / K2 (MRR@10) 的「边写边测」判分脚本, 读 tests/fixtures/eval/k1k2/draft.jsonl。
//
// 与 scripts/eval/kb-retrieval.ts 的关系: 口径完全照抄, 不另立新口径 ——
//   · 检索调用: stack.retriever.retrieveSync({ text: question, purpose: "recall", kinds: ["doc"], limit: 10 })  (kb-retrieval.ts:130)
//   · 结果路径: String(hit.entry.source).replace(/^kb:/, "")                                                  (kb-retrieval.ts:131)
//   · rank = 前 10 里首个属于 expect_paths 的名次; hit5 = 1 <= rank <= 5; rr = rank > 0 ? 1/rank : 0           (kb-retrieval.ts:132-134)
//   · 小节级命中: 前 5 条里有期望文件的切片且切片内容含 "/ " + section (只对 detail 类)                         (kb-retrieval.ts:133)
//   · K1 = hit5 数 / n; K2 = Σrr / n; 阈值 K1 >= 0.80, K2 >= 0.60                                             (kb-retrieval.ts:136-137, 143-144)
//   · 语料: KbSync 同步 --src 下 DEFAULT_KB_DIRS (blog / ai-docs / docs) 到一个临时 memory, embedder: null     (kb-retrieval.ts:125-128)
// 唯一的不同: kb-retrieval.ts 见到任何一条空 question 就拒绝打分 (退出码 2); 本脚本跳过空题, 只对已填的打分,
// 并且在未填 > 0 时把结果明确标为「部分结果, n=已填数」, 退出码仍是 2 (= 不是正式 K1/K2), 不写 eval-out/K1.json / K2.json,
// 不调用 writeReport —— 部分结果不能进报告。全部填完后, 正式数仍以 kb-retrieval.ts 为准 (见 --export)。
//
// 用法 (仓库根执行):
//   node --experimental-strip-types --no-warnings scripts/eval/k1k2-score.ts --src <博客根>            打分 (跳过空题)
//   node --experimental-strip-types --no-warnings scripts/eval/k1k2-score.ts --src <博客根> --check    只做机械校验: gold_path 存在 / gold_heading 真在文件里
//   node --experimental-strip-types --no-warnings scripts/eval/k1k2-score.ts --src <博客根> --export   全填完后写回 kb-queries.jsonl (question/author), 再跑 kb-retrieval.ts 出正式数
//   可选: --draft <路径> (默认 tests/fixtures/eval/k1k2/draft.jsonl), --json <输出文件> (把逐条结果写成 json, 默认不写)
// 退出码: 0 全填且 K1/K2 达标; 1 全填但未达标; 2 部分结果 / 一条未填 / 参数错 / 校验不过; 3 运行出错。
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { KbSync } from "../../src/kb/kb-sync.ts";
import { openMemoryStack } from "../../src/app/stack.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const arg = (n: string) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };
const DRAFT = resolve(REPO, arg("--draft") ?? "tests/fixtures/eval/k1k2/draft.jsonl");
const QUERIES = resolve(REPO, "tests/fixtures/eval/kb-queries.jsonl");
const K1_MIN = 0.8; // 与 kb-retrieval.ts:143 同值, 不许改松
const K2_MIN = 0.6; // 与 kb-retrieval.ts:144 同值, 不许改松

export interface DraftRow {
  id: string;
  kind: "title" | "detail" | "cross";
  dir: string;
  gold_path: string;
  gold_paths: string[];
  gold_heading: string;
  heading_level: "title" | "h1" | "h2";
  question: string;
  why: string;
  difficulty: string;
  author: string;
  source: string;
}

export function readDraft(file: string): DraftRow[] {
  return readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).map((l, i) => {
    const r = JSON.parse(l) as DraftRow;
    if (!r.id || !r.gold_path || !Array.isArray(r.gold_paths)) throw new Error(`${file}:${i + 1} 缺 id / gold_path / gold_paths`);
    return r;
  });
}

/** 机械校验: 每个 gold_paths 文件存在, gold_heading 真的是该文件的标题 (front matter title / # / ##)。 */
export function checkDraft(rows: DraftRow[], src: string): string[] {
  const bad: string[] = [];
  const ids = new Set<string>();
  for (const r of rows) {
    if (ids.has(r.id)) bad.push(`${r.id}: id 重复`);
    ids.add(r.id);
    if (r.gold_paths[0] !== r.gold_path) bad.push(`${r.id}: gold_paths[0] != gold_path`);
    for (const p of r.gold_paths) if (!existsSync(join(src, p))) bad.push(`${r.id}: 文件不存在 ${p}`);
    if (!existsSync(join(src, r.gold_path))) continue;
    const raw = readFileSync(join(src, r.gold_path), "utf8");
    const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
    const body = fm ? raw.slice(fm[0].length) : raw;
    const title = /^title:\s*["']?(.*?)["']?\s*$/m.exec(fm?.[1] ?? "")?.[1] ?? "";
    const h1 = [...body.matchAll(/^#\s+(.+?)\s*$/gm)].map((m) => m[1]!);
    const h2 = [...body.matchAll(/^##\s+(.+?)\s*$/gm)].map((m) => m[1]!);
    const ok = r.heading_level === "h2" ? h2.includes(r.gold_heading) : r.heading_level === "h1" ? h1.includes(r.gold_heading) : title === r.gold_heading && title !== "";
    if (!ok) bad.push(`${r.id}: 标题不在文件里 (${r.heading_level}) ${r.gold_heading} @ ${r.gold_path}`);
    if (r.kind === "detail" && r.heading_level !== "h2") bad.push(`${r.id}: detail 类的 gold_heading 必须是 ## 小节`);
  }
  return bad;
}

function score(rows: DraftRow[], src: string) {
  const mem = mkdtempSync(join(tmpdir(), "kb-k1k2-"));
  const stack = openMemoryStack(mem, { episodeRetentionDays: 0, embedder: null });
  try {
    new KbSync({ store: stack.store as never, root: src }).syncOnce();
    return rows.map((x) => {
      const section = x.kind === "detail" ? x.gold_heading : undefined;
      const res = stack.retriever.retrieveSync({ text: x.question, purpose: "recall", kinds: ["doc"], limit: 10 });
      const paths = res.hits.map((h) => String(h.entry.source ?? "").replace(/^kb:/, ""));
      const rank = paths.findIndex((p) => x.gold_paths.includes(p)) + 1;
      const secHit = section ? res.hits.slice(0, 5).some((h) => x.gold_paths.includes(String(h.entry.source).replace(/^kb:/, "")) && String((h.entry as { content?: string }).content ?? "").includes("/ " + section)) : null;
      return { id: x.id, kind: x.kind, group: x.dir === "docs" ? "notes" : "own", difficulty: x.difficulty, rank, hit5: rank > 0 && rank <= 5, rr: rank > 0 ? 1 / rank : 0, sectionHit: secHit, top: paths.slice(0, 5) };
    });
  } finally {
    stack.close();
    rmSync(mem, { recursive: true, force: true });
  }
}

function main(): number {
  const src = arg("--src");
  if (!src || !existsSync(src)) { console.error("用法: k1k2-score.ts --src <博客根> [--check | --export] [--draft <路径>] [--json <文件>]"); return 2; }
  if (!existsSync(DRAFT)) { console.error("缺少 " + DRAFT); return 2; }
  const all = readDraft(DRAFT);
  const bad = checkDraft(all, src);
  if (process.argv.includes("--check")) {
    console.log(`draft ${all.length} 行; 机械校验 ${bad.length ? "不通过 " + bad.length + " 处" : "通过 (gold_path 全部存在, gold_heading 全部是真实标题)"}`);
    for (const b of bad) console.log("  ✗ " + b);
    return bad.length ? 2 : 0;
  }
  if (bad.length) { console.error(`draft 机械校验不通过 ${bad.length} 处, 先修 (加 --check 看清单)`); return 2; }
  const filled = all.filter((r) => r.question?.trim());
  const empty = all.length - filled.length;
  if (process.argv.includes("--export")) {
    if (empty) { console.error(`还有 ${empty} 条未填, 不导出 (kb-retrieval.ts 也会拒绝打分)`); return 2; }
    const old = new Map(readFileSync(QUERIES, "utf8").split("\n").filter((l) => l.trim()).map((l) => { const q = JSON.parse(l); return [q.qid, q]; }));
    const out = all.map((r) => { const q = old.get(r.id); if (!q) throw new Error("kb-queries.jsonl 里没有 " + r.id); return JSON.stringify({ ...q, question: r.question.trim(), author: r.author || "human" }); });
    writeFileSync(QUERIES, out.join("\n") + "\n");
    console.log(`已写回 ${all.length} 条到 tests/fixtures/eval/kb-queries.jsonl; 正式数: node --experimental-strip-types --no-warnings scripts/eval/kb-retrieval.ts --src ${src}`);
    return 0;
  }
  console.log(`draft ${all.length} 条: 已填 ${filled.length} 条, 未填 ${empty} 条`);
  if (!filled.length) { console.log("已填 0 条, n=0; K1/K2 = 未测 (没有可打分的题)"); return 2; }
  const rows = score(filled, src);
  const n = rows.length;
  const k1 = rows.filter((r) => r.hit5).length / n;
  const k2 = rows.reduce((a, r) => a + r.rr, 0) / n;
  const byKind = Object.fromEntries(["title", "detail", "cross"].map((k) => { const rs = rows.filter((r) => r.kind === k); return [k, { n: rs.length, hit5: rs.filter((r) => r.hit5).length, mrr: rs.length ? +(rs.reduce((a, r) => a + r.rr, 0) / rs.length).toFixed(4) : null }]; }));
  const byGroup = Object.fromEntries(["own", "notes"].map((g) => { const rs = rows.filter((r) => r.group === g); return [g, { n: rs.length, hit5: rs.length ? +(rs.filter((r) => r.hit5).length / rs.length).toFixed(4) : null, mrr: rs.length ? +(rs.reduce((a, r) => a + r.rr, 0) / rs.length).toFixed(4) : null }]; }));
  const secRows = rows.filter((r) => r.sectionHit !== null);
  for (const r of rows) console.log(`  ${r.id} ${r.kind.padEnd(6)} rank=${r.rank || "-"}${r.sectionHit === null ? "" : r.sectionHit ? " §✓" : " §✗"}  top1=${r.top[0] ?? "(无)"}`);
  const tag = empty ? `【部分结果 n=${n} (已填 ${n} 条, 未填 ${empty} 条); 不是正式 K1/K2, 不可与阈值比较】` : `(n=${n}, 全部已填)`;
  console.log(`${tag} K1 Hit@5=${k1.toFixed(4)}  K2 MRR@10=${k2.toFixed(4)}`);
  console.log(`分类: ${JSON.stringify(byKind)}`);
  console.log(`分组: 自己的文章 (blog+ai-docs) ${JSON.stringify(byGroup.own)}; 学习笔记 (docs) ${JSON.stringify(byGroup.notes)}`);
  if (secRows.length) console.log(`小节级命中 (detail): ${secRows.filter((r) => r.sectionHit).length}/${secRows.length}`);
  const jsonOut = arg("--json");
  if (jsonOut) writeFileSync(resolve(REPO, jsonOut), JSON.stringify({ partial: empty > 0, filled: n, empty, k1, k2, byKind, byGroup, rows }, null, 2) + "\n");
  if (empty) return 2;
  console.log(`阈值: K1 >= ${K1_MIN} ${k1 >= K1_MIN ? "达标" : "未达标"}; K2 >= ${K2_MIN} ${k2 >= K2_MIN ? "达标" : "未达标"} (正式数请 --export 后用 kb-retrieval.ts 出)`);
  return k1 >= K1_MIN && k2 >= K2_MIN ? 0 : 1;
}

if (import.meta.url === "file://" + process.argv[1]) {
  try { process.exitCode = main(); } catch (e) { console.error(e); process.exitCode = 3; }
}
