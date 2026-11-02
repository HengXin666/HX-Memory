// scripts/backfill-sessions.ts — 一次性回填: 把 DSH 会话日志里「插件没在跑的那段时间」的对话, 走同一条 capture 链路重放入库。
//
// 为什么需要 (COLLECT-BROKEN.md): 2026-10-11 06:44 UTC 之后插件不在 dsh.profile.bundles 里 (用户在插件管理器里关掉),
// 这段时间的对话只留在 ~/.dsh/sessions/<桶>/session-<uuid>/session.v4.jsonl.zstd (老的 v3 / 无版本号) 里, 一条没进记忆。
//
// ## 「同一条链路」指什么
// 在线捕获是: session/event → HxMemoryRuntime.capture (配对成一轮问答) → flushTurn → EpisodeStore + CapturePipeline.run → FileBackend。
// 这里只换**触发源** (会话文件代替宿主事件), 后半段一个字不改:
//   · 配对规则与 runtime.capture 相同: turn/start 清空; user/message 只收 source.kind === "user" (插件注入/time-context 等不收);
//     assistant/message 收回答; turn/end 且 reason.kind ∈ {completed, max-tokens} 才算一轮 (completeTurn);
//     subagent 会话 (header.origin = subagent) 跳过 (= rootAgentsOnly 默认)。
//   · 落盘调 flushTurn (src/adapters/dsh/capture-ledger.ts), 与在线同一函数; 唯一多传的是 occurredAt = 这一轮 turn/end 的时间,
//     否则 3 周前的对话会以「今天」入库, 衰减起点整体后移 (旧结论冒充新结论)。
//
// ## 幂等
// 一轮的身份 = sessionId#turn。已处理的键记在 <root>/backfill/done.jsonl; 启动时还会把 <root>/capture/*.jsonl 里在线捕获过的
// (session, turn) 一并读进来 (停摆当天上午那几轮已经在线入过库, 不重复)。第二遍跑: 每一轮都命中已处理 ⇒ 新增 0。
//
// ## 质量闸 (用户关插件的原因是「当时效果不好」, 回填不能把老问题再灌一遍)
// 默认**必须**有 LLM 结构化器 (OpenAI 兼容接口): 没有 LLM 时 pipeline 会退回启发式, 而启发式不产结论 ⇒ content 就是用户原话,
// 这正是真库里 327 条 context 原话的来源 (见 MEMORY-DECAY.md「沉淀质量」一节)。没配模型就拒绝跑, 除非显式 --allow-heuristic。
//
// ## 用法
//   HX_BACKFILL_BASE_URL=https://…/v1 HX_BACKFILL_MODEL=… HX_BACKFILL_API_KEY=… \
//   node --experimental-strip-types --no-warnings scripts/backfill-sessions.ts \
//        [--since 2026-10-11T06:44:54Z] [--until <ISO>] [--sessions ~/.dsh/sessions] [--root ~/.dsh/hx-memory]
//        [--dry-run] [--allow-heuristic] [--limit-sessions N] [--json out.json]
//   key 也可以不放环境变量: 面板「模型」页保存的配置用 --panel-config 读取 (只读 baseUrl/model 与 keyMode=env 的变量名)。
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { FileBackend } from "../src/storage/file-store.ts";
import { listSessionFiles, parseSession, readZstd, type Ev, type Header } from "./lib/dsh-session-log.ts";
import { EpisodeStore } from "../src/storage/episode-store.ts";
import { CapturePipeline } from "../src/capture/pipeline.ts";
import type { TurnStructurer } from "../src/capture/structurer.ts";
import { buildTranscript, transcriptItemsOf } from "../src/capture/transcript.ts";
import { CaptureLog } from "../src/adapters/dsh/capture-log.ts";
import { completeTurn, flushTurn, type FlushTurnDeps } from "../src/adapters/dsh/capture-ledger.ts";
import { textOf } from "../src/adapters/dsh/session-text.ts";
import { projectOfSession } from "../src/adapters/dsh/project-key.ts";
import { parseStructurerOutput, structurerTurnText } from "../src/capture/structurer-io.ts";
import { DEFAULT_NEGATIVE_LESSON_PROMPT, DEFAULT_STRUCTURER_PROMPT, fillTemplate } from "../src/prompts.ts";
import { summarizeQuality, qualityOf } from "../src/app/memory-quality.ts";

const argv = process.argv.slice(2);
const opt = (k: string): string | undefined => {
  const i = argv.indexOf("--" + k);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (k: string) => argv.includes("--" + k);

const ROOT = resolve(opt("root") ?? process.env.HX_MEMORY_ROOT ?? join(homedir(), ".dsh", "hx-memory"));
const SESSIONS = resolve(opt("sessions") ?? join(homedir(), ".dsh", "sessions"));
const SINCE = Date.parse(opt("since") ?? "2026-10-11T06:44:54Z");
if (Number.isNaN(SINCE)) { console.error("--since 不是合法时间: " + opt("since")); process.exit(2); }
const UNTIL = opt("until") ? Date.parse(opt("until")!) : Number.POSITIVE_INFINITY;
const DRY = has("dry-run");
const LIMIT = opt("limit-sessions") ? Number(opt("limit-sessions")) : Number.POSITIVE_INFINITY;
const DONE_FILE = join(ROOT, "backfill", "done.jsonl");

// 会话文件的列举 / 多帧 zstd 解压 / 解析在 scripts/lib/dsh-session-log.ts (与 eval/memory-recall.ts 共用)。

// ---------- 配对 (与 HxMemoryRuntime.capture 同规则) ----------
interface Turn { turn: number; question: string; answer: string; at: number }
export function pairTurns(events: readonly Ev[]): Turn[] {
  const out: Turn[] = [];
  const state = { messages: [] as string[], answers: [] as string[], turnBase: 0, pending: [] as Array<{ question: string; answer: string; turn: number }> };
  let open = false;
  for (const e of events) {
    if (e.type === "turn/start") { state.messages = []; state.answers = []; open = true; continue; }
    if (!open) continue;
    if (e.type === "user/message") {
      if (e.data?.source?.kind !== "user") continue;
      const t = textOf(e.data);
      if (t) state.messages.push(t);
      continue;
    }
    if (e.type === "assistant/message") {
      const t = textOf(e.data);
      if (t) state.answers.push(t);
      continue;
    }
    if (e.type !== "turn/end") continue;
    const kind = e.data?.reason?.kind;
    if (kind === "completed" || kind === "max-tokens") {
      const pair = completeTurn(state, e as never);
      if (pair) {
        out.push({ turn: pair.turn, question: pair.question, answer: pair.answer, at: e.time ?? 0 });
        state.turnBase = Math.max(state.turnBase, pair.turn);
      }
    }
    state.messages = [];
    state.answers = [];
    open = false;
  }
  return out;
}

// ---------- LLM 结构化器 (OpenAI 兼容; 提示词与解析与 makeLlmStructurer 同一份) ----------
function modelConfig(): { baseUrl: string; model: string; key: string } | null {
  let baseUrl = process.env.HX_BACKFILL_BASE_URL ?? "";
  let model = process.env.HX_BACKFILL_MODEL ?? "";
  let key = process.env.HX_BACKFILL_API_KEY ?? "";
  const pc = opt("panel-config");
  if (pc && existsSync(pc)) {
    const c = JSON.parse(readFileSync(pc, "utf8"))?.model ?? {};
    baseUrl ||= c.baseUrl ?? "";
    model ||= c.model ?? "";
    if (!key && c.keyMode === "env" && c.keyEnv) key = process.env[c.keyEnv] ?? "";
  }
  return baseUrl && model ? { baseUrl: baseUrl.replace(/\/+$/, ""), model, key } : null;
}

function openAiStructurer(c: { baseUrl: string; model: string; key: string }): TurnStructurer {
  return {
    canConclude: true,
    async structure(input) {
      const isLesson = Boolean(input.transcript);
      const turn = structurerTurnText(input);
      const system = fillTemplate(isLesson ? DEFAULT_NEGATIVE_LESSON_PROMPT : DEFAULT_STRUCTURER_PROMPT, { input: turn });
      const r = await fetch(c.baseUrl + "/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", ...(c.key ? { authorization: "Bearer " + c.key } : {}) },
        signal: AbortSignal.timeout(60_000),
        body: JSON.stringify({ model: c.model, temperature: 0.2, max_tokens: 1024, messages: [{ role: "system", content: system }, { role: "user", content: turn }] }),
      });
      if (!r.ok) throw new Error("structurer HTTP " + r.status);
      const j = (await r.json()) as { choices?: Array<{ message?: { content?: string } }> };
      return parseStructurerOutput(j.choices?.[0]?.message?.content ?? "", input);
    },
  };
}

// ---------- 已处理集合 ----------
function loadDone(): Set<string> {
  const done = new Set<string>();
  if (existsSync(DONE_FILE)) {
    for (const l of readFileSync(DONE_FILE, "utf8").split("\n")) {
      if (!l) continue;
      try { done.add(JSON.parse(l).key); } catch { /* 坏行 */ }
    }
  }
  const capDir = join(ROOT, "capture");
  if (existsSync(capDir)) {
    for (const n of readdirSync(capDir).filter((x) => x.endsWith(".jsonl"))) {
      for (const l of readFileSync(join(capDir, n), "utf8").split("\n")) {
        if (!l) continue;
        try {
          const r = JSON.parse(l);
          if (r.session && typeof r.turn === "number" && r.turn > 0 && r.outcome !== "error") done.add(r.session + "#" + r.turn);
        } catch { /* 坏行 */ }
      }
    }
  }
  return done;
}

function countByKind(store: FileBackend): Record<string, number> {
  const m: Record<string, number> = {};
  for (const e of store.all()) m[e.kind] = (m[e.kind] ?? 0) + 1;
  return m;
}

// ---------- 主流程 ----------
export async function backfill() {
  const t0 = Date.now();
  const mc = modelConfig();
  if (!mc && !has("allow-heuristic") && !DRY) {
    console.error("✗ 没有配置 LLM (HX_BACKFILL_BASE_URL / HX_BACKFILL_MODEL / HX_BACKFILL_API_KEY, 或 --panel-config)。\n" +
      "  启发式结构化器不产结论, 回填进去的就是用户原话 (正是插件被关掉的原因)。确实要这样跑, 加 --allow-heuristic。");
    process.exit(2);
  }
  const files = listSessionFiles(SESSIONS);
  const done = loadDone();
  const report = {
    root: ROOT, sessionsDir: SESSIONS, since: new Date(SINCE).toISOString(), until: Number.isFinite(UNTIL) ? new Date(UNTIL).toISOString() : null,
    structurer: mc ? `openai-compatible ${mc.model}` : "heuristic (--allow-heuristic)", dryRun: DRY,
    files: files.length, sessionsInRange: 0, subagentSkipped: 0, unreadable: 0, unreadableFiles: [] as string[],
    turns: 0, alreadyDone: 0, replayed: 0, sessionsReplayed: 0,
    before: {} as Record<string, number>, after: {} as Record<string, number>, added: {} as Record<string, number>, addedTotal: 0,
    newEntries: [] as Array<{ id: string; kind: string; content: string; origin: string }>, quality: null as unknown, ms: 0,
  };
  mkdirSync(join(ROOT, "backfill"), { recursive: true });
  const store = new FileBackend({ root: ROOT });
  report.before = countByKind(store);
  const beforeIds = new Set(store.all().map((e) => e.id));
  const episodes = new EpisodeStore({ root: ROOT });
  const pipe = new CapturePipeline(store, {
    ...(mc ? { structurer: openAiStructurer(mc) } : {}),
    reviewRoot: ROOT,
    transcriptFor: (session: string) => {
      try { return buildTranscript(transcriptItemsOf(episodes.all(), session)); } catch { return undefined; }
    },
  });
  await pipe.warmUp();
  const deps: FlushTurnDeps = { pipe, episodes: () => episodes, log: () => new CaptureLog({ root: ROOT }), surface: "backfill", onError: (e) => console.error("  ! " + String(e)) };
  let n = 0;
  for (const f of files) {
    const s = parseSession(f);
    if (!s) { report.unreadable++; report.unreadableFiles.push(f); console.error("  ! 跳过无法解析的会话文件 (zstd/头缺失): " + f); continue; } // 损坏: 跳过并记账, 不中断
    const turns = pairTurns(s.events).filter((t) => t.at >= SINCE && t.at < UNTIL);
    if (!turns.length) continue;
    if (s.header.origin === "subagent") { report.subagentSkipped++; continue; }
    if (++n > LIMIT) break;
    report.sessionsInRange++;
    const session = { id: s.header.id, header: { cwd: s.header.cwd, origin: s.header.origin } };
    const project = projectOfSession(session as never);
    let touched = false;
    for (const t of turns) {
      report.turns++;
      const key = s.header.id + "#" + t.turn;
      if (done.has(key)) { report.alreadyDone++; continue; }
      if (DRY) { report.replayed++; touched = true; continue; }
      await flushTurn(deps, { session: s.header.id, ...(project ? { project } : {}), turn: t.turn, question: t.question, answer: t.answer, occurredAt: new Date(t.at).toISOString() });
      appendFileSync(DONE_FILE, JSON.stringify({ key, at: new Date().toISOString(), turnAt: new Date(t.at).toISOString() }) + "\n");
      done.add(key);
      report.replayed++;
      touched = true;
    }
    if (touched) report.sessionsReplayed++;
  }
  report.after = countByKind(store);
  const fresh = store.all().filter((e) => !beforeIds.has(e.id));
  for (const e of fresh) report.added[e.kind] = (report.added[e.kind] ?? 0) + 1;
  report.addedTotal = fresh.length;
  report.newEntries = fresh.map((e) => ({ id: e.id, kind: e.kind, content: e.content.slice(0, 300), origin: qualityOf(e).origin }));
  report.quality = summarizeQuality(fresh);
  store.close();
  report.ms = Date.now() - t0;
  return report;
}

if (process.argv[1]?.endsWith("backfill-sessions.ts")) {
  const r = await backfill();
  const { newEntries, ...brief } = r;
  console.log(JSON.stringify(brief, null, 2));
  const out = opt("json");
  if (out) writeFileSync(out, JSON.stringify(r, null, 2));
}

export { readZstd };
