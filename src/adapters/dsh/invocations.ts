// src/adapters/dsh/invocations.ts — AI 调用记录 (环形缓冲, 供面板「调用记录」tab 展示)。
import type { LlmInvocationRecord } from "./llm-agent.js";

const MAX = 200;

export class InvocationLog {
  private readonly buf: LlmInvocationRecord[] = [];

  push(r: LlmInvocationRecord): void {
    this.buf.push(r);
    if (this.buf.length > MAX) this.buf.splice(0, this.buf.length - MAX);
  }

  recent(limit = 50): LlmInvocationRecord[] {
    return this.buf.slice(-limit).reverse();
  }
}
