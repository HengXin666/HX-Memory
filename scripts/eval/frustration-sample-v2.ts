// scripts/eval/frustration-sample-v2.ts — 挫折检测集 v2 的候选抽样 (EVAL-CRITIQUE 第 5 节改法 1; 只抽样, 不标注)。
//
// 为什么: v1 的 196 条里 69% 来自 HX-Jungle 一个项目, 正例 92% 来自它, 81% 的正例是宽松词表先召回的 (对词表检测器有利)。
// 本脚本按 EVAL.md 2.3 的构造重抽: 覆盖全部有用户消息的桶, 每桶名额按消息数比例 (最少 5), 桶内一半「宽松词表命中」一半「随机未命中」,
// 每个会话最多贡献 5 条 (压住单会话主导)。抽样确定性: 种子固定, 同一份会话目录重跑结果相同。
// 产物: tests/fixtures/eval/frustration/candidates-v2.jsonl, label 留空 —— 必须由两名人工标注后才能当评测集 (EVAL 2.3 kappa ≥ 0.75)。
// 用法: node --experimental-strip-types --no-warnings scripts/eval/frustration-sample-v2.ts [--sessions ~/.dsh/sessions] [--n 600] [--out <file>]
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { listSessionFiles, parseSession } from "../lib/dsh-session-log.ts";
import { textOf } from "../../src/adapters/dsh/session-text.ts";
import { createDetector, LEXICON_MODEL } from "../../src/frustration/detect.ts";

const argv = process.argv.slice(2);
const opt = (k: string, d: string) => { const i = argv.indexOf("--" + k); return i >= 0 && argv[i + 1] ? argv[i + 1]! : d; };
const SESSIONS = resolve(opt("sessions", join(homedir(), ".dsh", "sessions")));
const N = Number(opt("n", "600"));
const OUT = resolve(opt("out", "tests/fixtures/eval/frustration/candidates-v2.jsonl"));
const PER_SESSION = 5;

const lex = createDetector({ model: LEXICON_MODEL });
interface C { bucket: string; session: string; text: string; prev: string; loose: boolean }
const byBucket = new Map<string, C[]>();
let unreadable = 0;
for (const f of listSessionFiles(SESSIONS)) {
  const s = parseSession(f);
  if (!s) { unreadable++; continue; }
  const parts = f.split("/");
  const session = parts[parts.length - 2]!, bucket = parts[parts.length - 3]!.replace(/^--home-[^-]+-/, "--home-<user>-");
  let prev = "";
  for (const e of s.events) {
    if (e.type === "assistant/message") { prev = textOf(e.data) || prev; continue; }
    if (e.type !== "user/message" || e.data?.source?.kind !== "user") continue;
    const t = textOf(e.data).trim();
    if (t.length < 2 || t.length > 2000) continue;
    (byBucket.get(bucket) ?? byBucket.set(bucket, []).get(bucket)!).push({ bucket, session, text: t, prev: prev.slice(0, 600), loose: lex.detect(t, prev).hit });
  }
}
let seed = 20261102;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
const shuffle = <T,>(xs: T[]) => { const a = [...xs]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j]!, a[i]!]; } return a; };
const total = [...byBucket.values()].reduce((a, v) => a + v.length, 0);
const out: C[] = [];
const report: Record<string, { messages: number; picked: number; loose: number }> = {};
for (const [b, cs] of [...byBucket.entries()].sort()) {
  const quota = Math.min(cs.length, Math.max(5, Math.round((N * cs.length) / total)));
  const perSession = new Map<string, number>();
  const take = (pool: C[], k: number) => {
    const got: C[] = [];
    for (const c of shuffle(pool)) {
      if (got.length >= k) break;
      const n = perSession.get(c.session) ?? 0;
      if (n >= PER_SESSION) continue;
      perSession.set(c.session, n + 1); got.push(c);
    }
    return got;
  };
  const hits = take(cs.filter((c) => c.loose), Math.ceil(quota / 2));
  const rest = take(cs.filter((c) => !c.loose), quota - hits.length);
  out.push(...hits, ...rest);
  report[b] = { messages: cs.length, picked: hits.length + rest.length, loose: hits.length };
}
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, out.map((c, i) => JSON.stringify({ sid: "v2-" + String(i + 1).padStart(4, "0"), text: c.text, prev_assistant: c.prev, label: "", annotator: "", source: { bucket: c.bucket, session: c.session, loose_hit: c.loose } })).join("\n") + "\n");
const buckets = Object.keys(report).length;
const top = Object.entries(report).sort((a, b) => b[1].picked - a[1].picked)[0];
console.log(`候选 ${out.length} 条, 覆盖 ${buckets} 个桶 (有用户消息的桶), 读不了的会话 ${unreadable}; 最大桶 ${top?.[0]} ${top?.[1].picked} 条 (${((100 * (top?.[1].picked ?? 0)) / out.length).toFixed(1)}%)`);
console.log(`宽松词表命中 ${out.filter((c) => c.loose).length} / 未命中 ${out.filter((c) => !c.loose).length}; 每会话上限 ${PER_SESSION}; label 留空, 需两名人工标注 (EVAL 2.3)`);
console.log("产物 " + OUT);
