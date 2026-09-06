// src/capture/engine.ts — 捕获引擎: 把一轮对话 (turn) 转成结构化记忆条目。
// 纯内核逻辑 (S1): 无网络, 无 harness, 无存储依赖 (只依赖 kernel/types)。
//
// 设计:
//   - 捕获分两级: 显式 ("记住 X") 与 隐式 (决策/教训/偏好信号)。
//   - 本级不用 LLM 抽取 (成本与不确定性); 用规则信号推断 kind, 确定性可测。
//   - 去重靠内容指纹 (contentHash): 相同内容不重复沉淀。
//   - 双时态: validAt = 事实生效时间 (可指定), assertedAt = 捕获时间。
import { createHash } from "node:crypto";
import type { MemoryEntry, MemoryKind, MemoryScope } from "../kernel/types.ts";

export interface TurnInput {
  text: string;
  project?: string;
  session: string;
  occurredAt?: string;
}

export interface CaptureOptions {
  mode?: "auto" | "explicit" | "off";
  forceKind?: MemoryKind;
}

export interface CaptureResult {
  entries: MemoryEntry[];
  deduped: number;
  signal: string;
}

const EXPLICIT_PATTERNS: RegExp[] = [
  /记住[:：]?\s*(.+)/,
  /记一下[:：]?\s*(.+)/,
  /记到记忆里[:：]?\s*(.+)/,
  /记住这个[:：]?\s*(.+)/,
  /记下[:：]?\s*(.+)/,
];

const LESSON_SIGNALS: RegExp[] = [
  /踩坑|教训|不要再|下次要|注意并发|注意幂等|注意超时/,
  /concurrency|idempoten|race condition|timeout|deadlock/i,
];

const DECISION_SIGNALS: RegExp[] = [
  /决定|采用|选择|改用|替换为|方案是|定稿|decided|chose|switch to/i,
];

const PREFERENCE_SIGNALS: RegExp[] = [/更喜欢|偏好|倾向|prefer|约定|规范是|习惯/];

const RULE_SIGNALS: RegExp[] = [
  /以后都要|以后必须|规则|不变量|invariant|所有容器|所有服务|所有系统/,
];

function inferKind(text: string): MemoryKind {
  if (EXPLICIT_PATTERNS.some((p) => p.test(text))) return "fact";
  if (RULE_SIGNALS.some((p) => p.test(text))) return "pattern";
  if (LESSON_SIGNALS.some((p) => p.test(text))) return "lesson";
  if (DECISION_SIGNALS.some((p) => p.test(text))) return "decision";
  if (PREFERENCE_SIGNALS.some((p) => p.test(text))) return "preference";
  return "context";
}

function contentHash(text: string): string {
  return createHash("sha256").update(text.trim()).digest("hex").slice(0, 16);
}

function extractExplicit(text: string): string | null {
  for (const p of EXPLICIT_PATTERNS) {
    const m = text.match(p);
    if (m?.[1]) return m[1].trim();
  }
  return null;
}

function shouldCapture(text: string, kind: MemoryKind, mode: CaptureOptions["mode"]): boolean {
  if (mode === "off") return false;
  if (kind === "fact") return true;
  if (mode === "explicit") return false;
  if (kind === "context") return false;
  return true;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * 把一轮对话捕获为记忆条目。纯函数 (除时间戳外无副作用)。
 * 返回 0 条的情况: off 模式 / 无信号 / 内容与已有指纹重复。
 */
export function captureTurn(
  input: TurnInput,
  opts: CaptureOptions = {},
  existingHashes: ReadonlySet<string> = new Set(),
): CaptureResult {
  const text = input.text.trim();
  if (!text) return { entries: [], deduped: 0, signal: "empty" };
  const mode = opts.mode ?? "auto";
  if (mode === "off") return { entries: [], deduped: 0, signal: "off" };

  const explicit = extractExplicit(text);
  const kind = opts.forceKind ?? (explicit ? "fact" : inferKind(text));
  if (!shouldCapture(text, kind, mode))
    return { entries: [], deduped: 0, signal: "no-signal:" + kind };

  const content = explicit ?? text;
  const hash = contentHash(content);
  if (existingHashes.has(hash)) return { entries: [], deduped: 1, signal: "duplicate:" + hash };

  const scope: MemoryScope = input.project ? "project" : "agent";
  const occurredAt = input.occurredAt ?? nowIso();
  const entry: MemoryEntry = {
    id: "c" + hash,
    kind,
    content,
    source: "session:" + input.session,
    scope,
    ts: { validAt: occurredAt, assertedAt: nowIso() },
  };
  return { entries: [entry], deduped: 0, signal: kind + ":" + hash };
}
