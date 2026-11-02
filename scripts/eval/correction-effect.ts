// scripts/eval/correction-effect.ts — EVAL C2 (同类错误复发率下降) 的确定性版本; C3 (同轮改正率) 只报「未测」及原因。
//
// 用法: node --experimental-strip-types --no-warnings scripts/eval/correction-effect.ts \
//         [--root ~/.dsh/hx-memory] [--sessions ~/.dsh/sessions] [--window-days 14] [--out eval-out] [--same-turn]
//
// C2 口径 (EVAL.md:35「1 − 规则生效后同类纠正次数 ÷ 生效前同类纠正次数, 按会话数归一化」):
//   规则 = 库里 kind ∈ {rule, lesson} 且 active 的条目, 生效时刻 T = assertedAt, 作用域 = 它的 project (缺省 = 全部项目)。
//   纠正 = DSH 会话里 source.kind=user 的消息被**线上检测器** (src/frustration/model.ts, 当前候选 A) 判中。
//   同类 = 纠正消息与规则正文共享 ≥ 2 个词项 (词项定义同 M2: ≥4 字符 ASCII 词 + 中文 4-gram, scripts/lib/m2-judge.ts)。
//   前段 = [T − 窗口, T − 2h) 且排除规则自己的源会话 (规则从那里提炼, 留着会抬高前段), 后段 = (T, T + 窗口]; 每段的率 = 同类纠正次数 ÷ 该段同项目会话数。
//   C2 = 1 − Σ后段率 ÷ Σ前段率 (只计前段率 > 0 的规则)。
// 对照 (不隐藏): 同样窗口里「全部纠正」(不要求同类) 的率变化。若全部纠正也同幅下降, 下降不能归因于规则。
// 时间切分泄漏检查 (EVAL F3): 规则源会话 (source 里的 session) 若出现在后段, 返回 2。
// C3 需要「下一 step 的行为与评审结论一致」的判定 → 要判官; 判官未配置时 --same-turn 输出「未测」并退出 2。
// 退出码: 0 = C2 >= 0.50; 1 = 测到但未达标; 2 = 无可判规则 / 泄漏 / C3 未测。
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { FileBackend } from "../../src/storage/file-store.ts";
import { isLiveEntry } from "../../src/kernel/visibility.ts";
import { createDetector } from "../../src/frustration/detect.ts";
import { MODEL } from "../../src/frustration/model.ts";
import { textOf } from "../../src/adapters/dsh/session-text.ts";
import { projectKeyOfCwd } from "../../src/adapters/dsh/project-key.ts";
import { listSessionFiles, parseSession } from "../lib/dsh-session-log.ts";
import { terms } from "../lib/m2-judge.ts";

const argv = process.argv.slice(2);
const opt = (k: string, d: string) => { const i = argv.indexOf("--" + k); return i >= 0 && argv[i + 1] ? argv[i + 1]! : d; };
const ROOT = resolve(opt("root", process.env.HX_MEMORY_ROOT ?? join(homedir(), ".dsh", "hx-memory")));
const SESSIONS = resolve(opt("sessions", join(homedir(), ".dsh", "sessions")));
const WINDOW = Number(opt("window-days", "14")) * 86_400_000;
const OUT = resolve(opt("out", "eval-out"));
const EXCLUDE_MS = Number(opt("exclude-hours", "2")) * 3_600_000;

if (argv.includes("--same-turn")) {
  console.log("C3 = 未测: 需要判官判定「下一 step 的行为是否与评审结论一致」, 面板 /api/model 的判官未配置 (judgeConfigured=false); C1 同因 n=0。");
  process.exit(2);
}
if (!existsSync(ROOT) || !existsSync(SESSIONS)) { console.error("找不到记忆根或会话目录"); process.exit(2); }

// ---------- 会话里的用户消息 (带时间、项目、是否纠正) ----------
const det = createDetector({ model: MODEL });
interface Msg { at: number; project: string; session: string; terms: Set<string>; correction: boolean }
const msgs: Msg[] = [];
const sessionsByProject = new Map<string, Array<{ session: string; at: number }>>();
let unreadable = 0;
for (const f of listSessionFiles(SESSIONS)) {
  const s = parseSession(f);
  if (!s) { unreadable++; continue; }
  const project = typeof s.header.cwd === "string" ? projectKeyOfCwd(s.header.cwd) ?? "?" : "?";
  const sid = f.slice(0, f.lastIndexOf("/")).split("/").pop()!;
  let first = 0, prevAssistant = "";
  for (const e of s.events) {
    if (e.type === "assistant/message") { prevAssistant = textOf(e.data) || prevAssistant; continue; }
    if (e.type !== "user/message" || e.data?.source?.kind !== "user") continue;
    const t = textOf(e.data);
    if (!t || !e.time) continue;
    if (!first) first = e.time;
    msgs.push({ at: e.time, project, session: sid, terms: terms(t), correction: det.detect(t, prevAssistant).hit });
  }
  if (first) (sessionsByProject.get(project) ?? sessionsByProject.set(project, []).get(project)!).push({ session: sid, at: first });
}

// ---------- 规则 ----------
const rules = new FileBackend({ root: ROOT }).all().filter((e) => (e.kind === "rule" || e.kind === "lesson") && isLiveEntry(e));
const sessionOf = (src: string) => /session-[0-9a-f-]{36}/.exec(src)?.[0] ?? "";
let leak = 0, noSrc = 0;
const rows: Array<{ id: string; kind: string; project: string; pre: number; post: number; preSessions: number; postSessions: number; preAll: number; postAll: number }> = [];
for (const r of rules) {
  const T = Date.parse(r.ts.assertedAt);
  if (!Number.isFinite(T)) continue;
  const proj = r.project ?? null;
  const rt = terms(r.content);
  if (rt.size < 2) continue;
  const inScope = (m: Msg) => !proj || m.project === proj;
  const sess = [...sessionsByProject.entries()].filter(([p]) => !proj || p === proj).flatMap(([, v]) => v);
  const preS = sess.filter((s) => s.at >= T - WINDOW && s.at < T - EXCLUDE_MS).length;
  const postS = sess.filter((s) => s.at > T && s.at <= T + WINDOW);
  if (!sessionOf(r.source)) noSrc++;
  else if (postS.some((s) => s.session === sessionOf(r.source))) leak++;
  if (!preS || !postS.length) continue;
  const same = (m: Msg) => { let n = 0; for (const w of rt) if (m.terms.has(w) && ++n >= 2) return true; return false; };
  const win = (a: number, b: number) => msgs.filter((m) => inScope(m) && m.correction && m.at >= a && m.at < b);
  // 前段排除规则自己的源会话: 规则 (尤其 lesson) 就是从那几句纠正里提炼的, 留着它们会把前段抬高 (回归均值偏差)。
  // 大多数 lesson 的 source 是 "session:tool" (没有会话 id, 443 条里 350 条), 无法按源会话排除 ⇒ 一律排除 T 前 2 小时 (规则通常提炼自刚刚那段对话)。
  const src = sessionOf(r.source);
  const preM = win(T - WINDOW, T - EXCLUDE_MS).filter((m) => m.session !== src), postM = win(T + 1, T + WINDOW + 1);
  rows.push({ id: r.id, kind: r.kind, project: proj ?? "(全部)", pre: preM.filter(same).length / preS, post: postM.filter(same).length / postS.length, preSessions: preS, postSessions: postS.length, preAll: preM.length / preS, postAll: postM.length / postS.length });
}
const used = rows.filter((x) => x.pre > 0);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const c2 = used.length ? 1 - sum(used.map((x) => x.post)) / sum(used.map((x) => x.pre)) : null;
const ctrl = rows.length && sum(rows.map((x) => x.preAll)) > 0 ? 1 - sum(rows.map((x) => x.postAll)) / sum(rows.map((x) => x.preAll)) : null;
const out = { metric: "C2", generatedAt: new Date().toISOString(), detector: { model: MODEL.version, candidate: (MODEL.meta as Record<string, unknown> | undefined)?.candidate ?? null }, windowDays: WINDOW / 86_400_000, messages: msgs.length, corrections: msgs.filter((m) => m.correction).length, unreadableSessions: unreadable, rules: rules.length, judgedRules: rows.length, rulesWithPre: used.length, leakage: leak, rulesWithoutSessionSource: noSrc, excludeHoursBeforeT: EXCLUDE_MS / 3_600_000, c2, controlAllCorrections: ctrl, threshold: 0.5, pass: c2 !== null && c2 >= 0.5 && leak === 0, rows: rows.sort((a, b) => b.pre - a.pre).slice(0, 50) };
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "C2.json"), JSON.stringify(out, null, 2) + "\n");
const f3 = (x: number | null) => (x === null ? "—" : x.toFixed(3));
console.log(`C2=${f3(c2)} (前段有同类纠正的规则 ${used.length} 条 / 可判 ${rows.length} 条 / 库里规则+教训 ${rules.length} 条)  对照(全部纠正)=${f3(ctrl)}  threshold 0.5  leakage ${leak} (源无会话 id 的规则 ${noSrc} 条, 泄漏检查对它们不可判; 前段一律排除 T 前 ${EXCLUDE_MS / 3_600_000} 小时)`);
console.log(`用户消息 ${msgs.length} 条, 检测器判中 ${out.corrections} 条 (候选 ${out.detector.candidate}); 窗口 ±${out.windowDays} 天; 读不了的会话 ${unreadable}`);
console.log("口径: 词项同类 + 线上检测器, 无判官; 产物 " + join(OUT, "C2.json"));
process.exit(leak > 0 || c2 === null ? 2 : out.pass ? 0 : 1);
