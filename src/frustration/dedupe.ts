// src/frustration/dedupe.ts — 按「会话 + 用户消息」去重 (PLAN.md J1.4 / J3.2, EVAL.md A3)。
//
// DSH 的 pre-step 每个 step 都会拿到同一条最新用户消息。REVIEW.md D4 实测: 外置链路一轮 10 个 step
// 反思了 10 次。这里给每条用户消息一个稳定的键, 检测与评审都只在第一次见到这个键时发生。
//
// 键的取法: 消息自带 id 时用 id; 没有 id 时用「它是本会话第几条直接用户消息 + 正文哈希」。
// 只用正文哈希不行: 用户隔几轮又说一遍同样的话 (例如「又错了」), 那是新的一次纠正, 必须再触发。
import { createHash } from "node:crypto";

export interface UserMessageRef {
  /** 稳定键 (见文件头)。 */
  key: string;
  /** 在 messages 数组里的下标。 */
  index: number;
  /** 本会话第几条直接用户消息 (从 1 开始)。 */
  ordinal: number;
  text: string;
}

type Msg = { role?: string; id?: unknown; source?: { kind?: string }; content?: unknown };

export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((p): p is { type: string; text?: string } => typeof p === "object" && p !== null)
    .map((p) => (p.type === "text" && typeof p.text === "string" ? p.text : ""))
    .join("");
}

/** 是不是用户直接输入 (插件注入的上下文也是 role:user, 必须排除)。 */
export function isDirectUser(m: unknown): boolean {
  const msg = m as Msg | undefined;
  if (!msg || msg.role !== "user") return false;
  if (msg.source?.kind !== undefined && msg.source.kind !== "user") return false;
  return textOf(msg.content).trim().length > 0;
}

/** 最新一条直接用户消息。没有时返回 null。 */
export function latestUserMessage(messages: readonly unknown[]): UserMessageRef | null {
  let ordinal = 0;
  let last: UserMessageRef | null = null;
  for (let i = 0; i < messages.length; i++) {
    if (!isDirectUser(messages[i])) continue;
    ordinal++;
    const m = messages[i] as Msg;
    const text = textOf(m.content);
    const id = typeof m.id === "string" && m.id ? m.id : "";
    const key = id || "u" + ordinal + ":" + createHash("sha1").update(text).digest("hex").slice(0, 12);
    last = { key, index: i, ordinal, text };
  }
  return last;
}

/** 已处理过的消息键 (进程内, 有上限)。 */
export class SeenMessages {
  private readonly seen = new Map<string, number>();
  private readonly cap: number;
  constructor(cap = 5000) {
    this.cap = cap;
  }

  /** 第一次见到返回 true 并登记; 之后都返回 false。 */
  claim(sessionId: string, key: string): boolean {
    const k = sessionId + "\u0000" + key;
    if (this.seen.has(k)) return false;
    this.seen.set(k, Date.now());
    if (this.seen.size > this.cap) {
      const oldest = this.seen.keys().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    return true;
  }

  has(sessionId: string, key: string): boolean {
    return this.seen.has(sessionId + "\u0000" + key);
  }
}
