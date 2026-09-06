// src/adapters/dsh/prestep.ts — agent/pre-step 确定性绑定注入 (VCP 式, 逐轮)。
// 在每一步开始前, 用"当前轮最新用户文本"做绑定检索注入, 而非只靠会话开始。
// 契约 (对齐 @deepseek-ai/dsh-agent-instructions 的权威写法):
//   ctx.on("agent/pre-step", async ({agent,messages,step,signal}, next) => {
//     const decision = await next();
//     ... 把要注入的上下文消息追加到 decision.messages (lastClaimedIndex+1) ...
//     return { kind: "enter", messages: ... };
//   });
// 关键差异: 注入与否由 Binder 代码判定 (声明绑定 + 信号词), 与模型是否调工具无关。
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import type { Binder } from "../../kernel/binder.ts";
import { MEMORY_PLUGIN_SOURCE } from "./guidance.js";

/** 从会话消息里提取最新一条用户文本 (content 可为 string 或 parts 数组)。 */
export function latestUserText(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; content?: unknown } | undefined;
    if (!m || m.role !== "user") continue;
    const c = m.content;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) {
      const text = c
        .filter((p): p is { type: string; text?: string } => typeof p === "object" && p !== null)
        .map((p) => (p.type === "text" && typeof p.text === "string" ? p.text : ""))
        .join("");
      if (text.trim()) return text;
    }
  }
  return "";
}

function messageTextOf(m: unknown): string {
  const mm = m as { content?: unknown } | undefined;
  if (!mm) return "";
  const cc = mm.content;
  if (typeof cc === "string") return cc;
  if (Array.isArray(cc)) {
    return cc
      .filter((p): p is { type: string; text?: string } => typeof p === "object" && p !== null)
      .map((p) => (p.type === "text" && typeof p.text === "string" ? p.text : ""))
      .join("");
  }
  return "";
}

export interface PreStepEnterDecision {
  kind: "enter";
  messages: unknown[];
}
export type PreStepDecision = { kind: "reject" } | PreStepEnterDecision;

interface PreStepPayload {
  agent: { session: { id: string; header?: { origin?: string } } };
  messages: unknown[];
  step: number;
  signal?: { aborted: boolean };
}

/** 逐轮确定性注入处理器。返回 DSH waterfall 的 handler。 */
export function makePreStepHandler(
  binder: Binder,
  options: { rootAgentsOnly: () => boolean; enabled: () => boolean },
) {
  return async (
    payload: PreStepPayload,
    next: () => Promise<PreStepDecision>,
  ): Promise<PreStepDecision> => {
    const decision = await next();
    if (decision.kind !== "enter") return decision;
    const agent = payload.agent;
    if (options.rootAgentsOnly() && agent.session.header?.origin === "subagent") return decision;
    if (!options.enabled()) return decision;
    const project = agent.session.id;
    const text = latestUserText(payload.messages);
    if (!text) return decision;
    const bound = binder.injectFor(project, text);
    if (!bound) return decision;
    // 内容去重: 若同一条注入块已在本 context 中, 跳过 (天然跨轮/跨步正确)
    const injected = createUserMessage({
      content: [{ type: "text", text: "【HX-Memory 绑定注入】\n" + bound }],
      source: { kind: "plugin", plugin: MEMORY_PLUGIN_SOURCE, form: "instructions" },
    });
    const msgs = decision.messages as unknown[];
    const claimed = payload.messages as unknown[];
    const injectedText = "【HX-Memory 绑定注入】\n" + bound;
    if (msgs.some((m) => messageTextOf(m) === injectedText)) return decision;
    // 插到最后一条 claimed 消息之后 (对齐 agent-instructions)
    let idx = msgs.length - 1;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (claimed.includes(msgs[i])) {
        idx = i;
        break;
      }
    }
    const nextMsgs = [...msgs.slice(0, idx + 1), injected, ...msgs.slice(idx + 1)];
    return { kind: "enter", messages: nextMsgs };
  };
}

/** 每次 turn/start 清空注入去重 (新轮允许重新注入)。 */
export function resetPrestepState(): void {
  // 由 runtime 在 turn/start 调用: 无外部状态时是 no-op (状态在 handler 闭包里)。
}
