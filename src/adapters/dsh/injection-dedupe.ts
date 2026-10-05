// adapters/dsh/injection-dedupe.ts — "本会话已经注入过什么" 的判据 (从 prestep.ts 拆出)。
//
// 为什么独立成文件 (§710 行数上限的又一次触发): 这是**一整块自洽的规则** —— 从会话日志里
// 认出本插件发过的注入块, 并抽出其中的条目 id。它不依赖 Binder、不依赖注入决策, 只依赖
// "注入块的形状"与"会话事件怎么读", 因此可以被单独审视与测试 (而 prestep.ts 剩下的部分
// 全是"怎么决定这一轮发什么")。
//
// ## 为什么必须双轨 (2026-09 修正, 实测)
//
// 只比"整块文本"时:
//   · 会话开始的注入块 (无标题/无框架句) 与预步的注入块 (有标题+框架句) **永不相等**
//     → 首次预步必然重复一份;
//   · 且预步每步重新拼块, 条目集合一变整块文本就变 → 已注入的条目被整份重发。
// 因此主判据是**条目 id 集合**, 文本相等只作为兜底。
import { isMemorySource } from "./guidance.js";
import { entryIdsOfSource, parseInjectedIds } from "../../kernel/injection-format.ts";
import { sessionEvents } from "./session-events.js";

/**
 * 记忆**条目块**的注入形态 (session-start 与 pre-step 都是它)。
 *
 * 为什么按 form 过滤: 同一个插件还有另一条无 id 的注入通道 (记忆指引块)。指引进不去,
 * "已注入条目"的判据才不会被它污染 —— 否则"库里没有不变量"的会话在首轮反而不注入。
 */
export const INJECTION_FORM = "instructions";

/** 本插件在本次会话里已经注入过的内容 (文本 + 条目 id)。 */
export interface PriorInjections {
  /** 注入块的完整文本 (整块去重: 完全相同的块不重发)。 */
  texts: Set<string>;
  /** 注入块里出现过的条目 id (差量注入的基线 —— 这才是主力判据)。 */
  ids: Set<string>;
}

/** 取一条消息的纯文本 (content 可为 string 或 parts 数组)。 */
export function messageTextOf(m: unknown): string {
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
 * 接受 Session 或 Agent (两者都常被调用方拿到)。
 *
 * 为什么不强制一种形状: session-start 的 payload 给的是 agent, 预步的 payload 也是 agent,
 * 但调用方 (例如需要"从'是否已注入源集合'里判断"的 runtime) 手上常常只有 session。
 * 归一化放在这里, 好过让每个调用方各自决定传哪一种。
 */
export function sessionOf(agentOrSession: unknown): unknown {
  const asAgent = agentOrSession as { session?: unknown } | null | undefined;
  if (asAgent && typeof asAgent === "object" && asAgent.session) return asAgent.session;
  return agentOrSession;
}

/**
 * 本插件在本次会话里已经注入过什么 (跨 step/跨轮去重)。
 * 读的是 surface 可见事件 (sessionEvents), 因此 compaction 遮蔽后不会再误判"已注入"。
 */
export function scanPriorInjections(agentOrSession: unknown): PriorInjections {
  const texts = new Set<string>();
  const ids = new Set<string>();
  const session = sessionOf(agentOrSession);
  for (const ev of sessionEvents(session)) {
    const e = ev as {
      type?: string;
      data?: {
        source?: { kind?: string; plugin?: string; form?: string };
        content?: unknown;
      };
    };
    if (e?.type !== "user/message") continue;
    const src = e.data?.source;
    if (!isMemorySource(src)) continue;
    if (src?.form !== INJECTION_FORM) continue;
    const text = messageTextOf({ content: e.data?.content });
    if (text) texts.add(text);
    // id 两路取 (2026-09-29): 新形态在 source.entryIds (正文里不再有 id, 省 88 token/块);
    // 旧形态在正文行尾标记 (历史会话日志里大量存在, 必须仍能解析 —— 否则去重基线清空,
    // 已注入过的常驻记忆会被整份重发)。两路合并, 顺序无关 (Set)。
    for (const id of entryIdsOfSource(src)) ids.add(id);
    if (text) for (const id of parseInjectedIds(text)) ids.add(id);
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

/**
 * 本会话是否已经有**记忆条目块** (带 id 标记的块) 进过上下文 —— `first` 模式的判据。
 *
 * 为什么按"会话事件"而不是内存计数: 预步可能被并发调用 (subagent/并行步), 内存计数
 * 会在并发下漏判; 而会话日志本身就是去重基线的权威来源 (与差量注入同一份判据)。
 * 只认**用户可见**的注入事件 (surface), compaction 遮蔽后重新注入 —— 保守且正确。
 *
 * ⚠ **那道取舍的代价已量化** (2026-09-18, §638): 全库 300 个会话里 **46 个有 ≥2 个注入块**,
 * 而其中 **33 个的条目 id 集合完全相同** —— 即它们正是"遮蔽后重注入同一批"。
 * 每次约 **450~470 tokens**, 合计约 **1.6 万 tokens** 的额外开销。
 *
 * **⇒ 但这不是缺陷**: 遮蔽后模型**确实看不见**那批记忆了, 不重注入等于让长会话
 * 彻底失去保底规则 —— 那比多花 token 更糟。**取舍的判据是"模型看得见吗", 不是"省 token"。**
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
 * 为什么必须做这一步: 会话开始用 `agent.inject()` 把块投进 inbox, 该块要等这一步的 claim
 * 批次被写进会话日志后才在 sessionEvents 里可见 —— 而 pre-step 在**那之前**运行。于是
 * 首轮必然重发一遍同样的常驻记忆 (实测 session-54bf3f3b: seq 10 与 seq 12, 6/8 个 id 重复)。
 * claimed 批次与 decision.messages 都是模型**即将**看见的内容, 口径与"已注入"完全一致。
 */
export function collectInjectionEntries(messages: unknown[], into: PriorInjections): void {
  for (const m of messages) {
    const src = (m as { source?: { kind?: string; plugin?: string; form?: string } } | undefined)
      ?.source;
    if (!isMemorySource(src)) continue;
    const text = messageTextOf(m);
    if (text) into.texts.add(text);
    // 同上: id 两路取 (source.entryIds 是新形态, 行尾标记是历史形态)。
    for (const id of entryIdsOfSource(src)) into.ids.add(id);
    if (text) for (const id of parseInjectedIds(text)) into.ids.add(id);
  }
}
