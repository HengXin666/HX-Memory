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
import {
  MEMORY_BLOCK_HEADING,
  memoryEntryHint,
  memoryFrameNote,
} from "../../kernel/format-frame.ts";
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

/**
 * 记忆**条目块**的注入形态 (session-start 与 pre-step 都是它)。
 *
 * 为什么按 form 过滤: 同一个插件还有另一条无 id 的注入通道 (记忆指引块)。指引进不了
 * 去, "已注入条目"的判据才不会被它污染 —— 否则"库里没有不变量"的会话在首轮反而不注入。
 */
export const INJECTION_FORM = "instructions";

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
export function scanPriorInjections(agentOrSession: unknown): PriorInjections {
  const texts = new Set<string>();
  const ids = new Set<string>();
  const session = sessionOf(agentOrSession);
  for (const ev of sessionEvents(session)) {
    const e = ev as {
      type?: string;
      data?: { source?: { kind?: string; plugin?: string; form?: string }; content?: unknown };
    };
    if (e?.type !== "user/message") continue;
    if (e.data?.source?.kind !== "plugin" || e.data.source.plugin !== MEMORY_PLUGIN_SOURCE) {
      continue;
    }
    if (e.data.source.form !== INJECTION_FORM) continue;
    const text = messageTextOf({ content: e.data.content });
    if (!text) continue;
    texts.add(text);
    for (const id of parseInjectedIds(text)) ids.add(id);
  }
  return { texts, ids };
}

/**
 * 接受 Session 或 Agent (两者都常被调用方拿到)。
 *
 * 为什么不强制一种形状: session-start 的 payload 给的是 agent, 预步的 payload 也是 agent,
 * 但调用方 (例如需要"从"是否已注入源集合"里判断的 runtime) 手上常常只有 session。
 * 归一化放在这里, 好过让每个调用方各自决定传哪一种。
 */
function sessionOf(agentOrSession: unknown): unknown {
  const asAgent = agentOrSession as { session?: unknown } | null | undefined;
  if (asAgent && typeof asAgent === "object" && asAgent.session) return asAgent.session;
  return agentOrSession;
}

/** 兼容保留: 只取"已注入的文本块"(旧接口, 测试与外部可继续用)。 */
export function priorInjections(agent: unknown): Set<string> {
  return scanPriorInjections(agent).texts;
}

/** 已注入过的条目 id 集合 (差量注入的基线)。 */
export function priorInjectedIds(agent: unknown): Set<string> {
  return scanPriorInjections(agent).ids;
}

/** 注入时机 (设置 memoryInjectMode): first = 只在会话首轮注入一次; every-turn = 逐轮差量。 */
export type InjectMode = "first" | "every-turn";

/**
 * 本会话是否已经有**记忆条目块** (带 id 标记的块) 进过上下文 —— `first` 模式的判据。
 *
 * 为什么按"会话事件"而不是内存计数: 预步可能被并发调用 (subagent/并行步), 内存计数
 * 会在并发下漏判; 而会话日志本身就是去重基线的权威来源 (与差量注入同一份判据)。
 * 只认**用户可见**的注入事件 (surface), compaction 遮蔽后重新注入 —— 保守且正确。
 *
 * 为什么判据是"有 id"而不是"有本插件的注入": 会话开始同时注入**指引块** (工具用法说明,
 * 无 id) 与条目块。用"注入过"当开关时, 只注入了指引的会话 (库里没有不变量、绑定也没命中)
 * 会被误判成"记忆已给过", 于是首轮预步不再注入 —— 恰恰丢掉了"模型没意识时唯一的保底"
 * (r00155cdb954e41c7)。只有真正带 id 的条目块才算"记忆已经进过上下文"。
 */
export function hasInjectedEntries(agentOrSession: unknown): boolean {
  return scanPriorInjections(agentOrSession).ids.size > 0;
}

/**
 * 把一批**待发消息**里的本插件注入块并进判重基线 (原地修改)。
 *
 * 为什么必须做这一步: 会话开始用 agent.inject() 把块投进 inbox, 该块要等这一步的 claim
 * 批次被写进会话日志后才在 sessionEvents 里可见 —— 而 pre-step 在**那之前**运行。于是
 * 首轮必然重发一遍同样的常驻记忆 (实测 session-54bf3f3b: seq 10 与 seq 12, 6/8 个 id 重复)。
 * claimed 批次与 decision.messages 都是模型**即将**看见的内容, 口径与"已注入"完全一致。
 */
function collectInjectionEntries(messages: unknown[], into: PriorInjections): void {
  for (const m of messages) {
    const src = (m as { source?: { kind?: string; plugin?: string; form?: string } } | undefined)
      ?.source;
    if (src?.kind !== "plugin" || src.plugin !== MEMORY_PLUGIN_SOURCE) continue;
    const text = messageTextOf(m);
    if (!text) continue;
    into.texts.add(text);
    for (const id of parseInjectedIds(text)) into.ids.add(id);
  }
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
    /** 注入时机 (默认 every-turn = 逐轮差量; first = 只在会话首轮注入一次)。 */
    injectMode?: () => InjectMode;
  },
) {
  const projectOf = options.projectOf ?? ((p: PreStepPayload) => p.agent.session.id);
  // 每次求值 (面板里改语言当轮生效) —— 参数属性/构造期固化在 strip-only 下同样不可用。
  const language = (): "zh" | "en" => options.language?.() ?? "zh";
  const injectMode = (): InjectMode => options.injectMode?.() ?? "every-turn";
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
    const msgs = decision.messages as unknown[];
    const prior = scanPriorInjections(agent);
    // 关键: 把**本轮 claimed 批次**里已有的注入也并进判重基线。
    //
    // 为什么必须并 (2026-09 实测): session-start 走的是 agent.inject() → 进 inbox; 它的
    // user/message 事件要等这一步的 claim 批次被写进会话日志才出现, 而 pre-step 在**那之前**
    // 就跑了。于是同一个会话开始的注入块 (以及它的 id 标记) 对这里的 scan 完全不可见 ——
    // 首轮必然再发一份 (session-54bf3f3b: seq 10 与 seq 12 两块, 8 个 id 里 6 个重复)。
    collectInjectionEntries(payload.messages, prior);
    collectInjectionEntries(msgs, prior);
    // first 模式: 本会话已经有过**记忆条目块** → 不再进入注入通道 (连检索都不做)。
    // 判据在 warm 之后取 (warm 会跨 await), 否则并发的首步会各注入一份。
    if (injectMode() === "first" && prior.ids.size > 0) return decision;
    // 差量注入: 把"本会话已注入过的条目 id"交给 Binder 排除。
    // 于是常驻记忆 (规则/关键事实) 只会在会话开始时进一次, 之后的轮次只补真正的新条目。
    const bound = binder.injectFor(project, text, [...prior.ids]);
    if (!bound) return decision;
    // 框架句在最前: 让模型知道这是"检索出来的证据", 并声明不覆盖当前指令 (对齐 DSH 的
    // workspace-instruction 做法)。硬约束: 框架句必须与记忆内容同块, 否则"证据"语义会丢。
    // 末尾追加可操作入口: "不适用就换词再查"。它必须与记忆内容同块 ——
    // 模型在收到检索结果时才最可能想到检索工具 (实测没有它时 memory_search 调用率 0/7440)。
    const injectedText =
      MEMORY_BLOCK_HEADING +
      "\n" +
      memoryFrameNote(language()) +
      "\n" +
      bound +
      "\n" +
      memoryEntryHint(language());
    // 去重: 本批已含, 或会话日志里已经注入过同一块 (跨 step/跨轮) → 跳过。
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
