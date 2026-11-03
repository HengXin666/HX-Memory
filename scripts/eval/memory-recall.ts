// scripts/eval/memory-recall.ts — M2 召回 (注入) 有用率: 注入给模型的记忆条目, 有多少在紧接着的回答里被用上。
//
// 用法 (Node 22.6+ / 24 / 26 均可):
//   node --experimental-strip-types --no-warnings scripts/eval/memory-recall.ts \
//     [--root ~/.dsh/hx-memory] [--sessions ~/.dsh/sessions] [--since 2026-10-01] [--until ...] \
//     [--kind rule] [--out eval-out] [--threshold 0.40]
//
// 数据: 记忆根 schedule/*.jsonl (pre-step 账本, outcome=injected 的行带注入条目 ids) + DSH 会话日志
//       (同一会话里, 注入时刻之后到该轮 turn/end 为止的 assistant 文本) + 记忆库 (按 id 取条目正文)。
//
// 判定 (确定性, 不调用模型; 与 docs/memory-failure-audit-20261006.md §四 的两档判据同口径, 另加「排除用户原话」):
//   词项 = 条目正文里 ≥4 字符的 ASCII 词 (去停用词) + 中文连续段的 4-gram。
//   严格命中: 条目词项去掉「本轮用户消息里也出现的词项」后仍 ≥2 个, 且其中 ≥50% 出现在回答里。
//            (去掉用户原话, 否则「回答复述了用户刚说的话」会被算成用上了记忆。)
//   宽松命中: 条目任一词项出现在回答里 (上界, 含巧合)。
//   M2_strict = 严格命中条数 ÷ 可判条数; M2_loose 同理。可判 = 条目在库里找得到 且 找得到对应回答。
//
// 与 EVAL.md M2 的差距 (写进输出, 不隐藏): EVAL 的 M2 要求判官判定 + 20% 人工复核 (F5) 且走 DSH 回放 (F7);
// 这里是基于真实账本与真实回答的引用核对, 判官部分在判官未配置时无法做。阈值 0.40 来自 EVAL.md, 未改。
//
// 退出码: 0 = 测到且 M2_strict >= 阈值; 1 = 测到但低于阈值; 2 = 无可判样本 / 参数错误。
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { FileBackend } from "../../src/storage/file-store.ts";
import { listSessionFiles, parseSession, type Ev } from "../lib/dsh-session-log.ts";
import { textOf } from "../../src/adapters/dsh/session-text.ts";

const argv = process.argv.slice(2);
const opt = (k: string): string | undefined => { const i = argv.indexOf("--" + k); return i >= 0 ? argv[i + 1] : undefined; };
const ROOT = resolve(opt("root") ?? process.env.HX_MEMORY_ROOT ?? join(homedir(), ".dsh", "hx-memory"));
const SESSIONS = resolve(opt("sessions") ?? join(homedir(), ".dsh", "sessions"));
const SINCE = opt("since") ? Date.parse(opt("since")!) : 0;
const UNTIL = opt("until") ? Date.parse(opt("until")!) : Number.POSITIVE_INFINITY;
const KIND = opt("kind");
const OUT = resolve(opt("out") ?? "eval-out");
const THRESHOLD = Number(opt("threshold") ?? "0.40");
if (Number.isNaN(SINCE) || Number.isNaN(UNTIL) || Number.isNaN(THRESHOLD)) { console.error("--since/--until/--threshold 不合法"); process.exit(2); }
if (!existsSync(join(ROOT, "schedule"))) { console.error("没有 pre-step 账本目录: " + join(ROOT, "schedule")); process.exit(2); }

import { judge, parseAt } from "../lib/m2-judge.ts";

interface Inj { session: string; at: number; ids: string[]; project?: string }
const injections: Inj[] = [];
for (const f of readdirSync(join(ROOT, "schedule")).filter((n) => n.endsWith(".jsonl")).sort()) {
  for (const line of readFileSync(join(ROOT, "schedule", f), "utf8").split("\n")) {
    if (!line.trim()) continue;
    let o: any;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.outcome !== "injected" || !Array.isArray(o.ids) || !o.ids.length) continue;
    const at = parseAt(o.at);
    if (!(at >= SINCE && at <= UNTIL)) continue;
    injections.push({ session: String(o.session ?? ""), at, ids: o.ids.map(String), project: o.project });
  }
}

// 会话文件: 目录名 session-<uuid> → 文件
const sessionFile = new Map<string, string>();
for (const f of listSessionFiles(SESSIONS)) {
  const dir = f.slice(0, f.lastIndexOf("/"));
  sessionFile.set(dir.slice(dir.lastIndexOf("/") + 1), f);
}

/** 注入时刻 (分钟精度) 之后第一轮: 取该轮 user 消息与 assistant 文本。 */
function turnAfter(events: readonly Ev[], at: number): { user: string; answer: string } | null {
  const from = at - 60_000; // 账本只到分钟, 往前放一分钟; 取第一个 time >= from 的 turn/start 开始的那一轮
  let open = false;
  const user: string[] = [], ans: string[] = [];
  for (const e of events) {
    if (!open) {
      if (e.type === "turn/start" && (e.time ?? 0) >= from) open = true;
      continue;
    }
    if (e.type === "user/message" && e.data?.source?.kind === "user") { const t = textOf(e.data); if (t) user.push(t); }
    else if (e.type === "assistant/message") { const t = textOf(e.data); if (t) ans.push(t); }
    else if (e.type === "turn/end") break;
  }
  return open && ans.length ? { user: user.join("\n"), answer: ans.join("\n") } : null;
}

const store = new FileBackend({ root: ROOT });
const byId = new Map(store.all().map((e) => [e.id, e]));
const parsed = new Map<string, Ev[] | null>();
const r = { injections: injections.length, injectedEntries: 0, missingEntry: 0, missingSession: 0, missingAnswer: 0, judged: 0, strict: 0, loose: 0, doc: 0, byKind: {} as Record<string, { judged: number; strict: number; loose: number }> };
const triples: Array<{ content: string; answer: string; user: string; session: string }> = [];
const samples: Array<{ session: string; id: string; kind: string; strict: boolean; loose: boolean; content: string }> = [];
for (const inj of injections) {
  let ev = parsed.get(inj.session);
  if (ev === undefined) {
    const f = sessionFile.get(inj.session);
    ev = f ? parseSession(f)?.events ?? null : null;
    parsed.set(inj.session, ev);
  }
  for (const id of inj.ids) {
    const e = byId.get(id);
    if (KIND && e && e.kind !== KIND) continue;
    r.injectedEntries++;
    if (!e) { r.missingEntry++; continue; }
    if (e.kind === "doc") r.doc++;
    if (!ev) { r.missingSession++; continue; }
    const t = turnAfter(ev, inj.at);
    if (!t) { r.missingAnswer++; continue; }
    const j = judge(e.content, t.answer, t.user);
    triples.push({ content: e.content, answer: t.answer, user: t.user, session: inj.session });
    r.judged++;
    if (j.strict) r.strict++;
    if (j.loose) r.loose++;
    const k = (r.byKind[e.kind] ??= { judged: 0, strict: 0, loose: 0 });
    k.judged++; if (j.strict) k.strict++; if (j.loose) k.loose++;
    if (samples.length < 40 || j.strict) samples.push({ session: inj.session, id, kind: e.kind, strict: j.strict, loose: j.loose, content: e.content.slice(0, 120) });
  }
}
const rate = (a: number, b: number) => (b ? a / b : null);
// 安慰剂对照 (2026-11-02 EVAL-CRITIQUE): 把每条条目配上**另一个会话**的回答 (按序号错开一半, 跳过同会话), 判据不变。
// 安慰剂命中率接近真实命中率 ⇒ 该判据量到的是词汇巧合, 不是「用上了」。
let pj = 0, ps = 0, pl = 0;
for (let i = 0; i < triples.length; i++) {
  const a = triples[i]!;
  for (let k = Math.floor(triples.length / 2), n = 0; n < triples.length; n++, k++) {
    const b = triples[(i + k) % triples.length]!;
    if (b.session === a.session) continue;
    const j = judge(a.content, b.answer, b.user);
    pj++; if (j.strict) ps++; if (j.loose) pl++;
    break;
  }
}
const out = {
  metric: "M2",
  generatedAt: new Date().toISOString(),
  method: "citation check on real pre-step ledger + real next answer; strict excludes terms already in the user's message; no judge model",
  gapVsEval: "EVAL M2 requires judge + 20% human review (F5) and DSH replay (F7); not done here",
  root: ROOT, sessions: SESSIONS, since: SINCE ? new Date(SINCE).toISOString() : null, kind: KIND ?? null,
  ...r,
  m2Strict: rate(r.strict, r.judged), m2Loose: rate(r.loose, r.judged), threshold: THRESHOLD,
  placebo: { judged: pj, strict: rate(ps, pj), loose: rate(pl, pj) },
  // EVAL-CRITIQUE 第 5 节改法 3: 报告时扣掉安慰剂 (真实值 − 安慰剂值), 这才是能归因到注入的部分。
  net: { strict: r.judged && pj ? r.strict / r.judged - ps / pj : null, loose: r.judged && pj ? r.loose / r.judged - pl / pj : null },
  pass: r.judged > 0 && (r.strict / r.judged) >= THRESHOLD,
  samples: samples.slice(0, 60),
};
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "M2.json"), JSON.stringify(out, null, 2) + "\n");
const f3 = (x: number | null) => (x === null ? "—" : x.toFixed(3));
console.log(`M2_strict=${f3(out.m2Strict)} (${r.strict}/${r.judged})  M2_loose=${f3(out.m2Loose)} (${r.loose}/${r.judged})  threshold ${THRESHOLD}  pass=${out.pass}`);
console.log(`安慰剂 (条目配别的会话的回答): strict ${f3(rate(ps, pj))} (${ps}/${pj})  loose ${f3(rate(pl, pj))} (${pl}/${pj})`);
console.log(`扣除安慰剂后: strict ${f3(out.net.strict)}  loose ${f3(out.net.loose)}  (这才是能归因到注入的部分; 「遵守」需要判官, 未测)`);
console.log(`注入 ${r.injections} 次 / ${r.injectedEntries} 条; 库里已无 ${r.missingEntry}, 会话缺 ${r.missingSession}, 找不到回答 ${r.missingAnswer}; doc 条目 ${r.doc}`);
for (const [k, v] of Object.entries(r.byKind).sort((a, b) => b[1].judged - a[1].judged)) console.log(`  ${k}: strict ${v.strict}/${v.judged}  loose ${v.loose}/${v.judged}`);
console.log("口径: 引用核对 (无判官); EVAL M2 的判官 + 20% 人工复核未做。产物 " + join(OUT, "M2.json"));
process.exit(r.judged === 0 ? 2 : out.pass ? 0 : 1);
