// src/adapters/dsh/prestep.ts — agent/pre-step 确定性绑定注入 (VCP 式, 逐轮)。
// 在每一步开始前, 用"当前轮最新用户文本"做绑定检索注入, 而非只靠会话开始。
// 契约 (对齐 @deepseek-ai/dsh-agent-instructions 的权威写法):
//   ctx.on("agent/pre-step", async ({agent,messages,step,signal}, next) => {
//     const decision = await next();
//     ... 把要注入的上下文消息追加到 decision.messages ...
//     return { kind: "enter", messages: ... };
//   });
// 关键差异: 注入与否由 Binder 代码判定 (声明绑定 + 信号词), 与模型是否调工具无关。
//
// 去重 (2026-09 修正): 注入出去的消息会进入会话日志, 不会出现在下一个 step 的 claimed
// batch 里 —— 只看 decision.messages 会每步重复注入。因此必须扫**模型可见的**历史事件
// (session-events.ts: 版本无关 + 按 surface 过滤) 里本插件 source 的注入。
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import type { Binder } from "../../kernel/binder.ts";
import { MEMORY_BLOCK_HEADING, memoryFrameNote } from "../../kernel/format-frame.ts";
import { MEMORY_PLUGIN_SOURCE } from "./guidance.js";
import { parseInjectedIds } from "../../kernel/injection-format.ts";
import { sessionEvents } from "./session-events.js";

/** 从会话消息里提取最新一条**直接用户**文本 (content 可为 string 或 parts 数组)。 */
export function latestUserText(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as
      { role?: string; source?: { kind?: string }; content?: unknown } | undefined;
    if (!m || m.role !== "user") continue;
    // 只认直接用户输入: plugin 注入的上下文 (AGENTS.md baseline/time-context/skill 目录)
    // 也是 role:user, 拿它当检索 query 会引入噪声。
    if (m.source?.kind !== undefined && m.source.kind !== "user") continue;
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

/** 本插件在本次会话里已经注入过的内容 (文本 + 条目 id)。 */
export interface PriorInjections {
  /** 注入块的完整文本 (整块去重: 完全相同的块不重发)。 */
  texts: Set<string>;
  /** 注入块里出现过的条目 id (差量注入的基线 —— 这才是主力判据)。 */
  ids: Set<string>;
}

/**
 * 本插件在本次会话里已经注入过什么 (跨 step/跨轮去重)。
 * 读的是 surface 可见事件 (sessionEvents), 因此 compaction 遮蔽后不会再误判"已注入"。
 *
 * 为什么必须双轨 (2026-09 修正): 只比"整块文本"时, 会话开始的注入块 (无标题/无框架句)
 * 与预步的注入块 (有标题+框架句) 永不相等 → 首次预步必然重复一份;
 * 且预步每步重新拼块, 条目集合一变整块文本就变 → 已注入的条目被整份重发。
 * 因此主判据是**条目 id 集合**, 文本相等只作为兜底。
 */
export function scanPriorInjections(agent: unknown): PriorInjections {
  const texts = new Set<string>();
  const ids = new Set<string>();
  const session = (agent as { session?: unknown } | undefined)?.session;
  for (const ev of sessionEvents(session)) {
    const e = ev as {
      type?: string;
      data?: { source?: { kind?: string; plugin?: string }; content?: unknown };
    };
    if (e?.type !== "user/message") continue;
    if (e.data?.source?.kind !== "plugin" || e.data.source.plugin !== MEMORY_PLUGIN_SOURCE) {
      continue;
    }
    const text = messageTextOf({ content: e.data.content });
    if (!text) continue;
    texts.add(text);
    for (const id of parseInjectedIds(text)) ids.add(id);
  }
  return { texts, ids };
}

/** 兼容保留: 只取"已注入的文本块"(旧接口, 测试与外部可继续用)。 */
export function priorInjections(agent: unknown): Set<string> {
  return scanPriorInjections(agent).texts;
}

/** 已注入过的条目 id 集合 (差量注入的基线)。 */
export function priorInjectedIds(agent: unknown): Set<string> {
  return scanPriorInjections(agent).ids;
}

export interface PreStepEnterDecision {
  kind: "enter";
  messages: unknown[];
}
export type PreStepDecision = { kind: "reject" } | PreStepEnterDecision;

export interface PreStepPayload {
  agent: {
    /** 真实 Session: 事件入口因版本而异, 统一走 session-events.ts 读取。 */
    session: { id: string; header?: { origin?: string; cwd?: string }; [key: string]: unknown };
  };
  messages: unknown[];
  step: number;
  signal?: { aborted: boolean };
}

/** 逐轮确定性注入处理器。返回 DSH waterfall 的 handler。 */
export function makePreStepHandler(
  binder: Binder,
  options: {
    rootAgentsOnly: () => boolean;
    enabled: () => boolean;
    /** 项目键派生 (默认取 session.id, 测试与 DSH adapter 可覆盖)。 */
    projectOf?: (payload: PreStepPayload) => string;
    /** 注入前预热异步投影的硬时限 (ms, 默认 50; 0 = 不预热)。 */
    warmupMs?: () => number;
    /** 框架句语言 (设置里的 language; 默认 zh)。 */
    language?: () => "zh" | "en";
  },
) {
  const projectOf = options.projectOf ?? ((p: PreStepPayload) => p.agent.session.id);
  // 每次求值 (面板里改语言当轮生效) —— 参数属性/构造期固化在 strip-only 下同样不可用。
  const language = (): "zh" | "en" => options.language?.() ?? "zh";
  return async (
    payload: PreStepPayload,
    next: () => Promise<PreStepDecision>,
  ): Promise<PreStepDecision> => {
    const decision = await next();
    if (decision.kind !== "enter") return decision;
    const agent = payload.agent;
    // 与 runtime/index 同口径: undefined 视为"过滤 subagent"。
    if (options.rootAgentsOnly() !== false && agent.session.header?.origin === "subagent") {
      return decision;
    }
    if (!options.enabled()) return decision;
    if (payload.signal?.aborted) return decision;
    const project = projectOf(payload);
    const text = latestUserText(payload.messages);
    if (!text) return decision;
    // 注入前热身异步向量投影 (硬时限): 首次预热可能补不齐, 后续轮次就有真语义召回了。
    await binder.warm(options.warmupMs?.() ?? 50, text);
    const prior = scanPriorInjections(agent);
    // 差量注入: 把"本会话已注入过的条目 id"交给 Binder 排除。
    // 于是常驻记忆 (规则/关键事实) 只会在会话开始时进一次, 之后的轮次只补真正的新条目。
    const bound = binder.injectFor(project, text, [...prior.ids]);
    if (!bound) return decision;
    // 框架句在最前: 让模型知道这是"检索出来的证据", 并声明不覆盖当前指令 (对齐 DSH 的
    // workspace-instruction 做法)。硬约束: 框架句必须与记忆内容同块, 否则"证据"语义会丢。
    const injectedText =
      MEMORY_BLOCK_HEADING + "\n" + memoryFrameNote(language()) + "\n" + bound;
    // 去重: 本批已含, 或会话日志里已经注入过同一块 (跨 step/跨轮) → 跳过。
    const msgs = decision.messages as unknown[];
    if (msgs.some((m) => messageTextOf(m) === injectedText)) return decision;
    if (prior.texts.has(injectedText)) return decision;
    const injected = createUserMessage({
      content: [{ type: "text", text: injectedText }],
      source: { kind: "plugin", plugin: MEMORY_PLUGIN_SOURCE, form: "instructions" },
    });
    // 插到最后一条 claimed 消息之后 (对齐 agent-instructions)
    const claimed = payload.messages as unknown[];
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
