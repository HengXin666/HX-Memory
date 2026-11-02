// src/frustration/review.ts — 同轮独立评审 (PLAN.md J3.2 / J3.3, EVAL.md C1)。
//
// 输入: 触发消息之前 N 轮的完整对话 (含工具调用与结果的摘要) + 最近一次 diff。
// 输出: 固定结构「错在哪 / 用户真正想要的做法 / 适用范围 / 证据」。
//
// 「独立上下文」的含义: 评审是一次单独的模型调用, 系统提示与输入都由这里拼装,
// 不复用主 agent 的会话。主 agent 的历史只作为**材料** (transcript) 进来。
//
// 入库闸门 (没证据不入库):
//   · 证据至少 1 条, 每条的原话必须能在 transcript 里逐字找到 (去掉空白后比对), 轮号落在材料范围内;
//   · 「做法」不能是模板句 (TEMPLATE_PHRASES), 也不能短于 6 个字;
//   · 模型输出不是合法 JSON、字段缺失、超时 → 不入库, 也不退回模板句。
import { textOf, isDirectUser } from "./dedupe.ts";

export interface LessonScope {
  /** 仓库根的绝对路径; 空串 = 不限仓库 (评审必须给出理由才允许, 见 parseLesson)。 */
  repo: string;
  /** 相对仓库根的目录前缀; 空串 = 整个仓库。 */
  dir: string;
  /** 任务类型, 封闭集合 TASK_TYPES。 */
  taskType: string;
}

export interface LessonEvidence {
  turn: number;
  quote: string;
}

export interface Lesson {
  id: string;
  createdAt: string;
  session: string;
  messageKey: string;
  /** 错在哪 (文件或符号)。 */
  where: string;
  /** 用户真正想要的做法。 */
  wanted: string;
  scope: LessonScope;
  evidence: LessonEvidence[];
  trigger: { text: string; via: string; kinds: string[] };
  /** where 里是否点名了文件或符号 (C1 的分子条件之一)。 */
  concrete: boolean;
}

export const TASK_TYPES = ["编码", "调试", "测试", "评审", "文档", "运维", "沟通", "任意"] as const;

/** 不入库的模板句 (评审超时或上下文不够时模型常退回这些)。 */
export const TEMPLATE_PHRASES: readonly string[] = [
  "注意细节", "更加仔细", "认真对待", "仔细检查", "避免错误", "避免类似错误", "提高质量", "多加注意",
  "认真听取用户", "理解用户需求", "按用户要求", "遵循用户指示", "下次注意", "确保正确",
];

export interface ReviewInput {
  /** 带轮号的对话材料。 */
  transcript: string;
  /** 材料里最早与最晚 (触发) 的轮号。 */
  firstTurn: number;
  triggerTurn: number;
  diff: string;
  repo: string;
  cwdDir: string;
  triggerText: string;
}

const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n) + " …(截断)" : s);

function partSummary(p: unknown): string {
  if (typeof p !== "object" || p === null) return "";
  const part = p as { type?: string; text?: string; name?: string; toolName?: string; input?: unknown; args?: unknown; output?: unknown; result?: unknown };
  if (part.type === "text") return part.text ?? "";
  const name = part.name ?? part.toolName;
  if (name) return "[工具 " + name + " " + clip(JSON.stringify(part.input ?? part.args ?? {}), 300) + "]";
  if (part.output !== undefined || part.result !== undefined) return "[结果 " + clip(JSON.stringify(part.output ?? part.result), 400) + "]";
  return "";
}

function messageText(m: unknown): string {
  const msg = m as { content?: unknown };
  if (Array.isArray(msg?.content)) return msg.content.map(partSummary).filter(Boolean).join("\n");
  return textOf(msg?.content);
}

/**
 * 拼评审材料: 以「直接用户消息」为轮的边界, 取触发消息所在轮及之前共 N 轮。
 * 每轮里 assistant 与工具消息按原顺序跟在用户消息后面。
 */
export function buildReviewInput(args: {
  messages: readonly unknown[];
  triggerIndex: number;
  turns: number;
  diff: string;
  repo: string;
  cwdDir: string;
}): ReviewInput {
  const { messages, triggerIndex } = args;
  // 每条消息所属的轮号。
  const turnOf: number[] = [];
  let turn = 0;
  for (let i = 0; i <= triggerIndex && i < messages.length; i++) {
    if (isDirectUser(messages[i])) turn++;
    turnOf.push(turn);
  }
  const triggerTurn = turn;
  const firstTurn = Math.max(1, triggerTurn - args.turns + 1);
  const lines: string[] = [];
  let current = -1;
  for (let i = 0; i <= triggerIndex && i < messages.length; i++) {
    const t = turnOf[i]!;
    if (t < firstTurn) continue;
    const m = messages[i] as { role?: string; source?: { kind?: string } };
    if (m?.role === "user" && !isDirectUser(m)) continue; // 插件注入的上下文不算材料
    if (t !== current) {
      lines.push("", "=== 第 " + t + " 轮 ===");
      current = t;
    }
    const body = clip(messageText(m).trim(), 4000);
    if (!body) continue;
    const who = m?.role === "user" ? "用户" : m?.role === "assistant" ? "助手" : m?.role === "tool" ? "工具结果" : String(m?.role ?? "?");
    lines.push(who + ": " + body);
  }
  return {
    transcript: lines.join("\n").trim(),
    firstTurn,
    triggerTurn,
    diff: clip(args.diff, 8000),
    repo: args.repo,
    cwdDir: args.cwdDir,
    triggerText: textOf((messages[triggerIndex] as { content?: unknown })?.content),
  };
}

export const REVIEW_SYSTEM_PROMPT = [
  "你是代码协作过程的评审员。用户刚刚在对话里批评或纠正了助手。",
  "你的任务: 根据下面的对话材料和最近一次代码改动, 找出助手具体做错了什么, 以及用户真正想要的做法。",
  "",
  "只输出一个 JSON 对象, 不要任何其它文字。字段:",
  '{"where": "错在哪: 点名文件路径、函数/符号或具体操作, 例如 src/a.ts 的 saveX() 没加锁",',
  ' "wanted": "用户真正想要的做法: 可执行的一句话, 写清该做什么, 不要写「注意」「仔细」这类空话",',
  ' "scope": {"repo": "仓库根路径, 照抄材料里给出的值; 只有确信这条做法与仓库无关时才写空串", "dir": "相对仓库根的目录, 只在这个目录生效时填写, 否则空串", "taskType": "编码|调试|测试|评审|文档|运维|沟通|任意 中的一个"},',
  ' "evidence": [{"turn": 轮号整数, "quote": "从材料里逐字复制的原话, 至少一条来自用户"}]}',
  "",
  "规则:",
  "1. evidence 里的 quote 必须逐字出现在材料中, 不得改写。找不到证据时输出 {\"evidence\": []}。",
  "2. 不要推测材料里没有的事实。",
  "3. 只写这一次批评对应的那一条做法。",
].join("\n");

export function reviewUserPrompt(input: ReviewInput): string {
  return [
    "仓库根: " + (input.repo || "(未知)"),
    "当前目录 (相对仓库根): " + (input.cwdDir || "."),
    "触发评审的用户消息 (第 " + input.triggerTurn + " 轮): " + clip(input.triggerText, 1000),
    "",
    "--- 对话材料 (第 " + input.firstTurn + " 到 " + input.triggerTurn + " 轮) ---",
    input.transcript,
    "",
    "--- 最近一次 diff ---",
    input.diff || "(无)",
  ].join("\n");
}

const squash = (s: string): string => s.replace(/\s+/g, "");

/** where 是否点名了文件或符号。 */
export function isConcrete(where: string): boolean {
  return (
    /[\w.-]+\/[\w./-]+/.test(where) || // 路径
    /\b[\w-]+\.(?:ts|tsx|js|mjs|cjs|py|md|json|jsonl|go|rs|java|sh|ya?ml|toml|css|html|sql)\b/i.test(where) ||
    /`[^`]+`/.test(where) ||
    /\b[A-Za-z_$][\w$]*\(\)?/.test(where) && /\(/.test(where) || // 调用形式
    /\b[a-z]+[A-Z][\w]*\b/.test(where) || // camelCase
    /\b[a-z0-9]+_[a-z0-9_]+\b/i.test(where) || // snake_case
    /--[a-z][\w-]+/.test(where) // 命令行参数
  );
}

export type ParseResult = { ok: true; lesson: Omit<Lesson, "id" | "createdAt" | "session" | "messageKey" | "trigger"> } | { ok: false; reason: string };

/** 解析并校验评审输出。任何一项不满足都不入库。 */
export function parseLesson(raw: string, input: ReviewInput): ParseResult {
  const json = /\{[\s\S]*\}/.exec(raw)?.[0];
  if (!json) return { ok: false, reason: "no-json" };
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: "bad-json" };
  }
  const evidenceRaw = Array.isArray(parsed.evidence) ? parsed.evidence : [];
  const material = squash(input.transcript);
  const evidence: LessonEvidence[] = [];
  for (const e of evidenceRaw) {
    const item = e as { turn?: unknown; quote?: unknown };
    const quote = typeof item.quote === "string" ? item.quote.trim() : "";
    const turn = Number(item.turn);
    if (squash(quote).length < 4) continue;
    if (!Number.isInteger(turn) || turn < input.firstTurn || turn > input.triggerTurn) continue;
    if (!material.includes(squash(quote))) continue;
    evidence.push({ turn, quote });
  }
  if (!evidence.length) return { ok: false, reason: "no-evidence" };
  const where = typeof parsed.where === "string" ? parsed.where.trim() : "";
  const wanted = typeof parsed.wanted === "string" ? parsed.wanted.trim() : "";
  if (!where) return { ok: false, reason: "no-where" };
  if (squash(wanted).length < 6) return { ok: false, reason: "wanted-too-short" };
  const template = TEMPLATE_PHRASES.find((p) => squash(wanted) === squash(p) || (squash(wanted).length <= squash(p).length + 6 && wanted.includes(p)));
  if (template) return { ok: false, reason: "template:" + template };
  const scopeRaw = (parsed.scope ?? {}) as { repo?: unknown; dir?: unknown; taskType?: unknown };
  const taskType = TASK_TYPES.includes(scopeRaw.taskType as (typeof TASK_TYPES)[number]) ? String(scopeRaw.taskType) : "任意";
  // repo 只接受「材料给的仓库根」或空串; 模型编的路径一律改回材料给的值。
  const repo = scopeRaw.repo === "" ? "" : input.repo;
  const rawDir = typeof scopeRaw.dir === "string" ? scopeRaw.dir.trim() : "";
  const dir = rawDir.includes("..") ? "" : rawDir.replace(/^\.\/?/, "").replace(/\/+$/, "");
  return {
    ok: true,
    lesson: { where, wanted, scope: { repo, dir: dir.startsWith("/") || dir.includes("..") ? "" : dir, taskType }, evidence, concrete: isConcrete(where) },
  };
}
