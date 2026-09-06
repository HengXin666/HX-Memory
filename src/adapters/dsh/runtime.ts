// src/adapters/dsh/runtime.ts — 会话运行时: 监听 session/event, 聚合 turn, 批量捕获。
// 类型策略: 用宽松结构类型 (SessionLike/SessionEventLike) 与 DSH 解耦,
// 任何发同类事件的 harness 都可复用 (仿 ReMe 的做法)。
import type { CapturePipeline } from "../../capture/pipeline.js";

export interface SessionLike {
  id: string;
}

export interface SessionEventLike {
  type: string;
  seq?: number;
  time?: number;
  data?: unknown;
}

interface TurnState {
  messages: string[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function textOf(data: unknown): string {
  if (typeof data === "string") return data;
  if (!isRecord(data)) return "";
  const content = data.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
      .join("");
  }
  return "";
}

export class HxMemoryRuntime {
  private readonly turns = new Map<string, TurnState>();

  constructor(
    private readonly pipe: CapturePipeline,
    private readonly settings: () => { autoCapture: boolean },
  ) {}

  onSessionStart(session: SessionLike): void {
    this.turns.set(session.id, { messages: [] });
  }

  onSessionEnd(session: SessionLike): void {
    this.turns.delete(session.id);
  }

  /** 消费一个 session/event。turn/end 且 reason=completed 时触发捕获。 */
  async capture(session: SessionLike, event: SessionEventLike): Promise<void> {
    if (!this.settings().autoCapture) return;
    const state = this.turns.get(session.id);
    if (event.type === "turn/start") {
      if (state) state.messages = [];
      else this.turns.set(session.id, { messages: [] });
      return;
    }
    if (event.type === "user/message") {
      const text = textOf(event.data);
      if (text && state) state.messages.push(text);
      return;
    }
    if (event.type !== "turn/end" || !state) return;
    const reason =
      isRecord(event.data) && isRecord(event.data.reason) ? event.data.reason : undefined;
    const kind = typeof reason?.kind === "string" ? reason.kind : undefined;
    const completed = kind === "completed" || kind === "max-tokens";
    if (completed && state.messages.length > 0) {
      const text = state.messages.join("\n");
      await this.pipe.run({ text, session: session.id });
    }
    state.messages = [];
  }
}
