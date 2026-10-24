// adapters/dsh/receipt.ts — **对话内可见回执**: 把"记忆层刚做了什么"变成对话里的一行。
//
// ## 为什么需要它 (2026-10-05, 用户实测)
//
// 用户的原话: "在跟 ai 对话的那个日志里面, 它能显示一条消息, 说沉淀了多少条, 或者说触发了沉淀,
// 而不是让我觉得这个插件根本就没生效。……你站在人的角度, 你作为老板, 你去骂了下司, 下司做错事了
// 以后, 下司还没有任何的悔改, 你觉得你不会把他给炒鱿鱼吗?"
//
// 也就是说: **沉默是致命的**。记忆层一直在工作 (注入、沉淀、判重), 但这些动作**只落在文件里**
// (`<root>/capture/*.jsonl`), 对话里一个字都看不到 ⇒ 用户无法判断它有没有生效, 也就无法信任它。
// 人格化的说法是"没有回执 = 没有悔改"。
//
// ## 形态: 复用宿主第一方的 notice 约定 (不是自己发明)
//
// 宿主自己在切模型时就是这么做的 (`dsh-agent` 的 `installModelSelection`):
//
//   agent.inject(createUserMessage({
//     content: [{ type: "text", text: "[model changed: …]" }],
//     source: { kind: "model-selection", form: "notice", summary: boundContextSummary("…") },
//   }));
//
// 三个要点照抄:
//   1. `form: "notice"` + `summary` (一行摘要)  这是宿主 UI **能折叠展示**的形态,
//      比一条普通 user 消息轻量得多 (summary 上限见 CONTEXT_SUMMARY_MAX_CHARS);
//   2. 走 `agent.inject()` 而不是改 pre-step 的 messages: inject 是**队列化**的,
//      它在下一次 claim 时进入对话, 不与注入块的"单一注入点"设计冲突;
//   3. 正文是**事实陈述** (做了什么), 不是给模型的任务指令  它是给**人**看的回执,
//      但模型也会读到, 因此措辞必须是对模型无害的 (纯陈述句)。
//
// ## 去重: summary 是判据
//
// 同一条回执**不该重复出现** (尤其"判重跳过"这类事件每步都可能触发)。因此按 `summary` 文本
// 在本会话已注入回执里查重  与注入块的双轨判重同一个思路, 但更简单 (回执是一次性事件,
// 没有"差量"的需要: 要么这条事件已经有了, 要么它就是新的)。
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { boundContextSummary } from "@deepseek-ai/dsh-llm";
import { isMemorySource } from "./guidance.js";
import { sessionEvents } from "./session-events.js";

/** 回执的 source kind (生产者自有命名空间; 与注入块同源但 form 不同)。 */
export const RECEIPT_SOURCE_KIND = "plugin:hx-memory";
/** 回执的 form (宿主 UI 据此折叠展示: 一行 summary + 可展开正文)。 */
export const RECEIPT_FORM = "notice";

/** 一条回执的内容。 */
export interface MemoryReceipt {
  /** 一行摘要 (对话里直接显示这行)。 */
  summary: string;
  /** 完整正文 (可展开时看; 缺省与 summary 相同)。 */
  text?: string;
}

/** 本会话已出现过的回执摘要 (按文本判重)。 */
export function scanPriorReceipts(agentOrSession: unknown): Set<string> {
  const out = new Set<string>();
  for (const ev of sessionEvents(sessionOf(agentOrSession))) {
    const e = ev as {
      type?: string;
      data?: { source?: { kind?: string; plugin?: string; form?: string; summary?: string } };
    };
    if (e?.type !== "user/message") continue;
    const src = e.data?.source;
    if (!isMemorySource(src)) continue;
    if (src?.form !== RECEIPT_FORM) continue;
    if (typeof src.summary === "string" && src.summary) out.add(src.summary);
  }
  return out;
}

/** Session 或 Agent 归一 (与 injection-dedupe.ts 同口径)。 */
function sessionOf(agentOrSession: unknown): unknown {
  const asAgent = agentOrSession as { session?: unknown } | null | undefined;
  if (asAgent && typeof asAgent === "object" && asAgent.session) return asAgent.session;
  return agentOrSession;
}

/** 本插件注入消息的 source (与 guidance.memoryMessageSource 同形状, 但带 notice 的 summary)。 */
export function receiptSource(summary: string): Record<string, unknown> {
  return {
    kind: RECEIPT_SOURCE_KIND,
    form: RECEIPT_FORM,
    // 宿主 UI 显示这一行; 有长度上限 (boundContextSummary), 超了会被截断 
    // 我们自己先截一次, 保证"截断后仍是完整的话"而不是半截。
    summary: boundContextSummary(summary),
  };
}

/**
 * 造一条回执消息 (不投递; 投递由调用方决定  见 `injectReceipt`)。
 *
 * 为什么把"造"与"投"分开: 前者是纯函数 (可测), 后者要拿 Agent (只有装配层有)。
 */
export function makeReceipt(input: MemoryReceipt): unknown {
  const summary = input.summary.trim();
  const text = (input.text ?? summary).trim();
  return createUserMessage({
    content: [{ type: "text", text }],
    source: receiptSource(summary) as never,
  });
}

/**
 * 投递一条回执到对话 (幂等: 同 summary 在本会话只发一次)。
 *
 * 静默降级: 拿不到 session/inject 时**什么都不做**  回执是**可观测性增强**,
 * 它绝不能成为捕获链路的故障点 (与账本写入同一纪律)。
 *
 * @returns 是否真的投出去了 (false = 重复/不可投递)。
 */
/**
 * **进程内**已发出的回执 (按 agent 分桶)。
 *
 * ⚠ 为什么必须有它 (2026-10-05 实测, 单测抓到的真缺陷): `agent.inject()` 是**队列化**的 
 * 消息要等下一步的 claim 批次被写进会话日志后才在 `sessionEvents` 里可见。因此两次连续调用
 * (同一步内, 或跨步但在 claim 之前) 时, `scanPriorReceipts` **都查不到**第一条,
 * 于是同一条回执会被重复投递  而这正是"注入去重"那类缺陷的同一形状 (只扫日志会漏掉在途消息)。
 *
 * 用 `WeakMap` 而不是普通 Map: 键是 agent 对象, 会话 dispose 后应随之释放 (不额外持有引用)。
 */
const EMITTED = new WeakMap<object, Set<string>>();

export function injectReceipt(agent: unknown, receipt: MemoryReceipt): boolean {
  const a = agent as
    | { inject?: (m: unknown) => void; session?: unknown }
    | null
    | undefined;
  if (!a || typeof a.inject !== "function") return false;
  const summary = receipt.summary.trim();
  if (!summary) return false;
  const key = boundContextSummary(summary);
  // 两路判重 (与注入块的"双轨"同一思路):
  //   ① 已在途 (本次进程发过, 但还没进会话日志) → 跳过;
  //   ② 已在日志里 (历史会话/重启前发过) → 跳过。
  const emitted = EMITTED.get(a as object) ?? new Set<string>();
  if (emitted.has(key) || scanPriorReceipts(a).has(key)) return false;
  try {
    a.inject(makeReceipt(receipt));
    emitted.add(key);
    EMITTED.set(a as object, emitted);
    return true;
  } catch {
    // 宿主拒绝这条消息 (形状/准入) 不该影响任何事情。
    return false;
  }
}

/**
 * 装配层的**回执投递器**工厂: 按 session 找 agent 并投递。
 *
 * 为什么收进本模块 (而不是留在组装根): 它是本模块的**唯一使用面**  组装根只该得到
 * 一个"给我 session 与内容, 我负责发"的函数, 不该知道 WeakMap/enabled/取 agent 这些细节。
 * runtime (沉淀回执) 与 prestep (骂人回执) 共用同一个实例, 因此两处口径不可能分叉。
 */
export function makeReceiptSender(deps: {
  enabled: () => boolean;
  agentOf: (sessionId: string) => unknown;
}): (sessionId: string, r: MemoryReceipt) => void {
  return (sessionId, r) => {
    if (!deps.enabled()) return;
    const agent = deps.agentOf(sessionId);
    if (agent) injectReceipt(agent, r);
  };
}
