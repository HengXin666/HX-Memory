// scripts/eval/derive-decay.ts — 从用户自己的历史对话推导"规则多久会被改写", 给 kernel/temporal.ts 的半衰期定数。
//
// 做什么:
//   1. 读 ~/.dsh/sessions/**/session*.jsonl.zstd 里**人发的**消息 (跳过 subagent 会话、系统注入块);
//   2. 切成句子, 留下"规范性断言" (以后/必须/不要/禁止/统一/默认/强制… 这类在给 AI 定规矩的句子);
//   3. 每条断言 a 往后找同话题的断言 b (判据与线上同一个: temporal.sameTopicRevision):
//        · b 带改写信号 (改为/不再/以后…) → 记一次"改写", 间隔 Δ = t_b - t_a;
//        · 否则 → "重申" (说明它在 Δ 时仍然有效);
//   4. "是不是改写"由人 (或模型) 判: 词面判据在真实对话上几乎抓不到改写 (实测 230 句只抓到 1 次,
//      用户改规矩时很少复述原句)。所以脚本先导出候选对 (每句断言 → 同项目里第一句话题重合 >= 0.3 的后续断言),
//      对随机样本打标 R(改写)/S(重申)/U(无关), 再用样本里的改写率估计全体:
//        已标 R → 在 Δ 天处发生事件; 已标 S/U → 删失到数据末尾; 未标 → 以样本改写率 p 计期望事件。
//      带删失的指数生存: λ = 期望事件数 / 期望暴露天数, 半衰期 H = ln2 / λ, 并给 bootstrap 区间。
//
// 用法:
//   node --experimental-strip-types scripts/eval/derive-decay.ts [--sessions ~/.dsh/sessions] [--out eval-out/decay-derivation.json]
//   node --experimental-strip-types scripts/eval/derive-decay.ts --messages msgs.jsonl   # 已抽好的 {time,text,origin,proj,sid} 行
//   --labels eval-out/decay-labels.jsonl   打标文件 ({key, label: "R"|"S"|"U"} 每行一条; 缺省时只导出候选)
//   --pairs-out eval-out/decay-pairs.jsonl 候选对导出位置
import { readdirSync, readFileSync, statSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import * as zlib from "node:zlib";
import { tokenSet } from "../../src/kernel/cjk.ts";
import { overlapCoefficient, REVISION_MARKERS, sameTopicRevision } from "../../src/kernel/temporal.ts";

const argv = process.argv.slice(2);
const opt = (n: string) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : undefined;
};
const SESSIONS = opt("--sessions") ?? join(homedir(), ".dsh", "sessions");
const OUT = opt("--out") ?? "eval-out/decay-derivation.json";
const DAY = 86_400_000;

interface Msg { time: number; text: string; proj: string; sid: string }

// ---------- 读消息 ----------
/**
 * 会话文件解压 (多帧 zstd)
 * .agents/notes/implemented/feature/2026-11-01-temporal-confidence-decay.md
 */
function zstdText(buf: Buffer): string {
  // zstd CLI 最稳 (会话文件是多帧拼接); 没有 CLI 时按帧魔数切开逐帧解。
  const cli = spawnSync("zstd", ["-dcq"], { input: buf, maxBuffer: 1 << 30 });
  if (cli.status === 0 && cli.stdout?.length) return cli.stdout.toString("utf8");
  const dec = (zlib as unknown as { zstdDecompressSync?: (b: Buffer) => Buffer }).zstdDecompressSync;
  if (!dec) throw new Error("需要 zstd 命令或 Node >= 22.15 (zlib.zstdDecompressSync)");
  const idx: number[] = [];
  for (let i = 0; i <= buf.length - 4; i++) if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) idx.push(i);
  const out: Buffer[] = [];
  let start = idx[0] ?? 0;
  for (let k = 0; k < idx.length; k++) {
    if (idx[k]! < start) continue;
    for (let e = k + 1; e <= idx.length; e++) {
      const end = e < idx.length ? idx[e]! : buf.length;
      try {
        out.push(dec(buf.subarray(idx[k]!, end)));
        start = end;
        break;
      } catch {
        /* 魔数出现在压缩数据内部: 继续往后找帧尾 */
      }
    }
  }
  return Buffer.concat(out).toString("utf8");
}

function* sessionFiles(dir: string): Generator<string> {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    const st = statSync(p);
    if (st.isDirectory()) yield* sessionFiles(p);
    else if (/^session.*\.jsonl(\.zstd)?$/.test(n)) yield p;
  }
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((c) => (c && typeof c === "object" && "text" in c ? String((c as { text: unknown }).text) : "")).join("");
}

function loadFromSessions(root: string): Msg[] {
  const out: Msg[] = [];
  for (const f of sessionFiles(root)) {
    const raw = readFileSync(f);
    const text = f.endsWith(".zstd") ? zstdText(raw) : raw.toString("utf8");
    let origin: string | undefined;
    const parts = f.split("/");
    for (const line of text.split("\n")) {
      if (!line) continue;
      let o: { type?: string; origin?: string; time?: number; data?: { content?: unknown } };
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      if (o.type === "session") origin = o.origin;
      else if (o.type === "user/message" && typeof o.time === "number") {
        out.push({ time: o.time, text: textOf(o.data?.content), proj: parts.at(-3) ?? "", sid: (parts.at(-2) ?? "") + (origin === "subagent" ? "#sub" : "") });
      }
    }
  }
  return out;
}

function loadFromJsonl(file: string): Msg[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Msg & { origin?: string })
    .map((m) => ({ time: m.time, text: m.text, proj: m.proj, sid: m.sid + (m.origin === "subagent" ? "#sub" : "") }));
}

// ---------- 只留人发的、在定规矩的句子 ----------
/** 系统/代理注入的消息形状 (不是人打的字)。 */
const MACHINE = /^(HX-Memory:|Current runtime context|<system-reminder>|<|\[|\{|任务[:：]|Task:|You are |# |Here is|Background:|背景[:：])/;
/**
 * 人打的字: 用户靠语音输入, 句子口语、不带 markdown。父 agent 转进来的报告/计划 (带 ` ** | → 列表编号, 或很长) 不算。
 * 真库实测: 不加这一条时 2712 句"断言"里大半是 agent 写的结论 (如"约束遵守: 全程只读…")。
 */
const STRUCTURED = /`|\*\*|\||→|^\s*[-*] |^\s*\d+[.)、] /m;
/** 规范性断言: 在给 AI 定规矩。 */
export const DIRECTIVE = /以后|今后|一律|必须|务必|不要|不许|不准|禁止|别再|永远|永不|统一|默认|记住|规则|约束|铁律|强制|红线|只能|只允许|always|never|must|don't/i;

interface Assertion { t: number; text: string; tokens: Set<string>; proj: string }

function assertionsOf(msgs: readonly Msg[]): Assertion[] {
  const out: Assertion[] = [];
  for (const m of msgs) {
    if (m.sid.endsWith("#sub")) continue; // 子代理会话里的 "user" 是父 agent, 不是人
    const text = m.text.trim();
    if (!text || MACHINE.test(text) || text.length > 800 || STRUCTURED.test(text) || text.split("\n").length > 8) continue;
    for (const s of text.split(/(?<=[。！？!?；;\n])/)) {
      const sent = s.trim();
      if (sent.length < 6 || sent.length > 300 || !DIRECTIVE.test(sent)) continue;
      const tokens = tokenSet(sent);
      if (tokens.size < 3) continue;
      out.push({ t: m.time, text: sent, tokens, proj: m.proj });
    }
  }
  // 同一句在短时间内被重复发送 (重试/粘贴) 只算一次。
  out.sort((a, b) => a.t - b.t);
  const seen = new Map<string, number>();
  return out.filter((a) => {
    const prev = seen.get(a.text);
    seen.set(a.text, a.t);
    return prev === undefined || a.t - prev > DAY;
  });
}

// ---------- 生存分析 ----------
const msgs = opt("--messages") ? loadFromJsonl(opt("--messages")!) : loadFromSessions(SESSIONS);
const human = msgs.filter((m) => !m.sid.endsWith("#sub"));
const A = assertionsOf(msgs);
const tEnd = Math.max(...msgs.map((m) => m.time));
const tStart = Math.min(...human.map((m) => m.time));

// 候选对: 每句断言 → 同项目里第一句话题重合 >= 0.3 的后续断言 (同一条消息里的其它句不算)。
interface Pair { key: string; i: number; j: number; overlap: number; days: number }
const pairs: Pair[] = [];
for (let i = 0; i < A.length; i++) {
  const a = A[i]!;
  for (let j = i + 1; j < A.length; j++) {
    const b = A[j]!;
    if (b.proj !== a.proj || b.t - a.t < 60_000) continue;
    const ov = overlapCoefficient(a.tokens, b.tokens);
    if (ov < 0.3) continue;
    pairs.push({ key: a.t + ":" + b.t, i, j, overlap: +ov.toFixed(3), days: (b.t - a.t) / DAY });
    break;
  }
}
const PAIRS_OUT = opt("--pairs-out") ?? "eval-out/decay-pairs.jsonl";
if (!existsSync(dirname(PAIRS_OUT))) mkdirSync(dirname(PAIRS_OUT), { recursive: true });
writeFileSync(PAIRS_OUT, pairs.map((p) => JSON.stringify({ key: p.key, overlap: p.overlap, days: +p.days.toFixed(2), old: A[p.i]!.text, new: A[p.j]!.text, lexicalRevision: sameTopicRevision(p.overlap, A[p.i]!.text, A[p.j]!.text) && REVISION_MARKERS.test(A[p.j]!.text) })).join("\n") + "\n");

const labels = new Map<string, "R" | "S" | "U">();
if (opt("--labels") && existsSync(opt("--labels")!)) {
  for (const l of readFileSync(opt("--labels")!, "utf8").split("\n").filter(Boolean)) {
    const o = JSON.parse(l) as { key: string; label: "R" | "S" | "U" };
    labels.set(o.key, o.label);
  }
}
const pairOf = new Map(pairs.map((p) => [p.i, p]));
const labeled = pairs.filter((p) => labels.has(p.key));

function estimate(sample: readonly Pair[]) {
  const nR = sample.filter((p) => labels.get(p.key) === "R").length;
  const pR = sample.length ? nR / sample.length : 0;
  let events = 0;
  let exposure = 0;
  for (let i = 0; i < A.length; i++) {
    const full = (tEnd - A[i]!.t) / DAY;
    const p = pairOf.get(i);
    if (!p) { exposure += full; continue; }
    const lab = labels.get(p.key);
    const q = lab === undefined ? pR : lab === "R" ? 1 : 0; // 这一对是改写的概率
    events += q;
    exposure += q * p.days + (1 - q) * full;
  }
  const lambda = exposure > 0 ? events / exposure : 0;
  return { pR, nR, lambda, H: lambda > 0 ? Math.LN2 / lambda : Number.POSITIVE_INFINITY, events, exposure };
}
const est = estimate(labeled);
// bootstrap: 重采样已标样本, 看改写率的不确定性传到 H 上有多宽。
let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const Hs: number[] = [];
for (let b = 0; b < 400 && labeled.length; b++) {
  const sample = labeled.map(() => labeled[Math.floor(rnd() * labeled.length)]!);
  // 只重采样"未标对的改写率", 已标的仍按标签计 (与 estimate 同口径)。
  const nR = sample.filter((p) => labels.get(p.key) === "R").length;
  const pR = nR / sample.length;
  let ev = 0, ex = 0;
  for (let i = 0; i < A.length; i++) {
    const full = (tEnd - A[i]!.t) / DAY;
    const p = pairOf.get(i);
    if (!p) { ex += full; continue; }
    const lab = labels.get(p.key);
    const q = lab === undefined ? pR : lab === "R" ? 1 : 0;
    ev += q; ex += q * p.days + (1 - q) * full;
  }
  Hs.push(ev > 0 ? (Math.LN2 * ex) / ev : Number.POSITIVE_INFINITY);
}
Hs.sort((x, y) => x - y);
const pct = (q: number) => (Hs.length ? +Hs[Math.min(Hs.length - 1, Math.floor(q * Hs.length))]!.toFixed(1) : null);
const H = est.H;
// 经验存活率 (只用已标对 + 没有候选的断言; 暴露不足 d 天且未改写的是删失, 不进分母)。
const survival = (d: number) => {
  let n = 0, alive = 0;
  for (let i = 0; i < A.length; i++) {
    const p = pairOf.get(i);
    const lab = p ? labels.get(p.key) : undefined;
    if (p && lab === undefined) continue;
    const revisedAt = lab === "R" ? p!.days : undefined;
    const full = (tEnd - A[i]!.t) / DAY;
    if (revisedAt === undefined && full < d) continue;
    n++;
    if (revisedAt === undefined || revisedAt >= d) alive++;
  }
  return { d, n, empirical: n ? +(alive / n).toFixed(3) : null, model: +Math.pow(0.5, d / H).toFixed(3) };
};
// ---------- 项目活跃度: 一条指令所在的仓库, d 天后还有没有人在里面说话 ----------
// 规则绝大多数是项目内的 ("这个仓库的前端…", "这个服务的代理…")。显式改写很少 (上面的 R 率),
// 但仓库会停摆、换方向: 停摆仓库里的规则不会被"推翻", 只是不再相关。这条曲线就是"不再相关"的速度。
// S(d) = P(同项目在 t+d 之后还有人发的消息 | t 时刻的一条消息), 只统计暴露够 d 天的消息; 拟合 S(d) = 2^(-d/H)。
const humanTyped = msgs.filter((m) => !m.sid.endsWith("#sub") && !MACHINE.test(m.text.trim()) && m.text.trim().length <= 800 && !STRUCTURED.test(m.text) && m.text.split("\n").length <= 8 && m.text.trim());
const lastByProj = new Map<string, number>();
for (const m of humanTyped) lastByProj.set(m.proj, Math.max(lastByProj.get(m.proj) ?? 0, m.time));
const activity = [1, 3, 7, 14, 21, 30, 45, 60].map((d) => {
  let n = 0, alive = 0;
  for (const m of humanTyped) {
    if (tEnd - m.time < d * DAY) continue;
    n++;
    if (lastByProj.get(m.proj)! >= m.time + d * DAY) alive++;
  }
  return { d, n, alive: n ? +(alive / n).toFixed(3) : null };
});
// 最小二乘过原点: -log2 S(d) = d / H。样本数太少的长尾点 (n < 1000) 不参与, 数据窗口只有约 80 天。
const fitPts = activity.filter((a) => a.alive !== null && a.alive > 0 && a.alive < 1 && a.n >= 1000);
const num = fitPts.reduce((acc, a) => acc + a.d * -Math.log2(a.alive!), 0);
const den = fitPts.reduce((acc, a) => acc + a.d * a.d, 0);
const activityH = num > 0 ? den / num : Number.POSITIVE_INFINITY;

const result = {
  generatedAt: new Date().toISOString(),
  span: { from: new Date(tStart).toISOString(), to: new Date(tEnd).toISOString(), days: +((tEnd - tStart) / DAY).toFixed(1) },
  messages: { total: msgs.length, human: human.length, sessions: new Set(human.map((m) => m.sid)).size },
  assertions: A.length,
  candidatePairs: pairs.length,
  labeled: { n: labeled.length, R: labeled.filter((p) => labels.get(p.key) === "R").length, S: labeled.filter((p) => labels.get(p.key) === "S").length, U: labeled.filter((p) => labels.get(p.key) === "U").length },
  lexicalRevisionsFound: pairs.filter((p) => sameTopicRevision(p.overlap, A[p.i]!.text, A[p.j]!.text) && REVISION_MARKERS.test(A[p.j]!.text)).length,
  revisionRate: +est.pR.toFixed(3),
  revisions: +est.events.toFixed(1),
  exposureDays: +est.exposure.toFixed(1),
  lambdaPerDay: +est.lambda.toFixed(5),
  halfLifeDays: +H.toFixed(1),
  halfLifeCI90: [pct(0.05), pct(0.95)],
  survival: [1, 3, 7, 14, 30, 60].map(survival),
  activity: { messages: humanTyped.length, projects: lastByProj.size, points: activity, fitOn: fitPts.map((a) => a.d), halfLifeDays: +activityH.toFixed(1), model: activity.map((a) => ({ d: a.d, model: +Math.pow(0.5, a.d / activityH).toFixed(3) })) },
  recommendation: {
    rule: Math.round(activityH),
    decision: Math.round(activityH),
    why: "显式改写的半衰期远长于仓库停摆的半衰期, 所以排序用后者; 改写交给同话题新压旧 (它不等曲线, 当天生效)",
  },
  examples: labeled
    .filter((p) => labels.get(p.key) === "R")
    .sort((a, b) => a.days - b.days)
    .slice(0, 12)
    .map((p) => ({ at: new Date(A[p.i]!.t).toISOString().slice(0, 10), afterDays: +p.days.toFixed(2), old: A[p.i]!.text.slice(0, 120), new: A[p.j]!.text.slice(0, 120) })),
};
if (!existsSync(dirname(OUT))) mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(result, null, 2));
console.log(JSON.stringify({ ...result, examples: result.examples.length }, null, 2));
