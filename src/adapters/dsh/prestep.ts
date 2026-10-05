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
import { composeMemoryBlock } from "../../kernel/format-frame.ts";
import { memoryMessageSource } from "./guidance.js";
import type { PendingGuidance } from "./session-start.js";
import type { TriggerDecision } from "../../trigger/policy.ts";
import {
  INJECTION_FORM,
  collectInjectionEntries,
  messageTextOf,
  scanPriorInjections,
} from "./injection-dedupe.js";
// 判据实现搬到 injection-dedupe.ts (§710 行数上限); 转出去让既有 import 不被打断
// (对外 API 一字不变 —— 搬运实现不该改变依赖图的形状)。
export {
  INJECTION_FORM,
  collectInjectionEntries,
  messageTextOf,
  scanPriorInjections,
  priorInjections,
  priorInjectedIds,
  hasInjectedEntries,
  type PriorInjections,
} from "./injection-dedupe.js";
import type { ProjectScopeArg } from "../../kernel/project-lineage.ts";

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

/** 一次判定的落账输入 (不含时间戳: 由账本自己盖, 保证时间只有一个来源)。 */
export interface PreStepRecord {
  session: string;
  project: string;
  step: number;
  channel: "binding" | "trigger" | "none";
  /** 触发决策模式; 声明式绑定通道不经过 TriggerPolicy, 记 null。 */
  mode: TriggerDecision["mode"] | null;
  outcome: "injected" | "skipped" | "nothing-new" | "empty";
  intent: string | null;
  confidence: number;
  topicDrift: number;
  reason: string;
  selected: string[];
  ids: string[];
  tokens: number;
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
    /**
     * 工作区上下文派生 (优先于 projectOf): 返回对象 (含祖先链) 时获得层级可见性。
     * 保留 projectOf 是为了让既有调用点与既有测试**一字不改** —— 层级能力是叠加的。
     */
    scopeOf?: (payload: PreStepPayload) => ProjectScopeArg | undefined;
    /** 注入前预热异步投影的硬时限 (ms, 默认 50; 0 = 不预热)。 */
    warmupMs?: () => number;
    /** 框架句语言 (设置里的 language; 默认 zh)。 */
    language?: () => "zh" | "en";
    /** 注入时机 (默认 every-turn = 逐轮差量; first = 只在会话首轮注入一次)。 */
    /** 注入时机: `first` = 只在会话首轮注入一次; `every-turn` = 逐轮差量补新。 */
    injectMode?: () => "first" | "every-turn";
    /**
     * 待发指引 (由 session-start 装入, 见 session-start.ts)。取走即清空。
     *
     * 为什么由 pre-step 取它 (而不是会话开始时单独发一条): 见下方"单一注入点"的注释 ——
     * 指引与条目是**同一个块**的两部分, 分开发就是用户看到的"注入了2次"。
     * 容器为空 = 不附指引 (只发条目块)。
     */
    pendingGuidance?: PendingGuidance;
    /**
     * 判定落账 (可选): 每一次真实判定都会回调一次, **含"没注入"的那几种**。
     *
     * 为什么由 pre-step 回调而不是让调用方事后读 Binder: 只有这里同时拿着 step 与判定结果,
     * 而"为什么这轮没注入"与"注入了什么"必须同源 —— 事后读 Binder 只能拿到最后一次状态,
     * 会把"库里没有"与"被判重挡掉"混成同一个读数 (真实缺陷类别)。
     * 实现方必须 best-effort (写失败不许抛), 否则账本会拖垮对话。
     */
    onDecision?: (decision: PreStepRecord) => void;
    /**
     * 负面/纠正提示 (可选; 异步)。
     *
     * ⚠ 这是 pre-step 里**唯一**允许的 await (除 warm 之外): 它便宜 (词表未命中时同步返回),
     * 而它的价值全在"当下" —— 等到下一轮再提示, 用户已经又气了一轮。
     * 判据与内容由 negativity-wiring.ts 决定, 这里只负责"有就并进同一个块"。
     */
    negativeHint?: (text: string) => Promise<string | undefined>;
    /**
     * 每步回调 (可选; 用于**运行时自检** —— 例如"会话登记是否生效")。
     *
     * 为什么在这里而不是另注册一个 pre-step 监听器: 另注册会插进监听器表的第 0 位,
     * 而既有调用方与测试按 `[0]` 取注入处理器 —— 那个顺序依赖会被静默破坏 (实测 5 个测试红)。
     */
    onStep?: () => void;
  },
) {
  // scopeOf 优先 (带祖先链); 只有 projectOf / 都没有时退化为单值语义。
  const scopeOf = (p: PreStepPayload): ProjectScopeArg =>
    options.scopeOf?.(p) ?? options.projectOf?.(p) ?? p.agent.session.id;
  // 每次求值 (面板里改语言当轮生效) —— 参数属性/构造期固化在 strip-only 下同样不可用。
  const language = (): "zh" | "en" => options.language?.() ?? "zh";
  const injectMode = (): "first" | "every-turn" => options.injectMode?.() ?? "every-turn";
  return async (
    payload: PreStepPayload,
    next: () => Promise<PreStepDecision>,
  ): Promise<PreStepDecision> => {
    const decision = await next();
    options.onStep?.();
    if (decision.kind !== "enter") return decision;
    const agent = payload.agent;
    // 与 runtime/index 同口径: undefined 视为"过滤 subagent"。
    if (options.rootAgentsOnly() !== false && agent.session.header?.origin === "subagent") {
      return decision;
    }
    if (!options.enabled()) return decision;
    if (payload.signal?.aborted) return decision;
    const scope = scopeOf(payload);
    // 账本记的是**可读的项目名** (链的最内层); 可见性判定用整条链 (见 scopeOfSession)。
    const project = typeof scope === "string" ? scope : (scope?.project ?? "");
    const text = latestUserText(payload.messages);
    if (!text) return decision;
    // 注入前热身异步向量投影 (硬时限): 首次预热可能补不齐, 后续轮次就有真语义召回了。
    // project 必须一起传: always-on 缓存是**按项目**存的, 热错了一份等于没热 (首轮就没保底)。
    await binder.warm(options.warmupMs?.() ?? 50, text, scope);
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
    // 账本: 每一次**真实判定**都留一条 (含"没注入"与"为什么")。
    // 为什么在这里而不是在 index.ts 的事件回调里: 只有这里同时知道 step 与判定结果,
    // 而设计目标要的正是"'为什么没注入'必须和'注入了什么'一样可查"。
    const record = (outcome: "injected" | "skipped" | "nothing-new" | "empty"): void => {
      if (!options.onDecision) return;
      const d = binder.lastTriggerDecision();
      options.onDecision({
        session: agent.session.id,
        project,
        step: payload.step,
        channel: binder.lastInjectionChannel(),
        mode: d?.mode ?? null,
        outcome,
        intent: d?.intent ?? null,
        confidence: d?.confidence ?? 0,
        topicDrift: d?.topicDrift ?? 0,
        reason: d?.reason ?? "",
        selected: [...binder.lastSelectedIds()],
        ids: [...binder.lastInjectedIds()],
        tokens: binder.lastInjectedTokens(),
      });
    };
    // 单一注入点 (2026-09, 用户实测 "别注入2次, 就只能注入一次"):
    // 此前指引由 session-start 单独发一条、条目由这里发一条 —— 一次会话里模型读到两块
    // HX-Memory 内容 (session-b000974f: seq 10 指引 + seq 13 条目)。两者本就是同一件事
    // (怎么用 + 用到了什么), 因此**合并进同一个块**, 且只有这里会注入。
    //
    // 为什么不是"让 session-start 也发条目块, 预步保持安静": 会话开始时还不知道用户会问什么,
    // 那份块必然是全量常驻条目; 而首轮预步手里有**真实用户文本**, 同一条目在相关度排序与
    // 预算扣减下更准。合并到有查询文本的那一次, 信息量只增不减。
    //
    // 取 (take) 是破坏性的: 拿不到条目时**必须放回**, 否则指引会被一次空转消耗掉
    // (实测存在"首轮无条目"的会话: 库里没有不变量 + 绑定没命中)。
    const pending = prior.texts.size === 0 ? (options.pendingGuidance?.take(agent.session.id) ?? "") : "";
    const putBack = (): void => {
      if (pending) options.pendingGuidance?.set(agent.session.id, pending);
    };
    // first 模式: 本会话已经有过**记忆条目块** → 不再进入注入通道 (连检索都不做)。
    // 判据在 warm 之后取 (warm 会跨 await), 否则并发的首步会各注入一份。
    if (injectMode() === "first" && prior.ids.size > 0) {
      putBack();
      record("skipped");
      return decision;
    }
    // 差量注入: 把"本会话已注入过的条目 id"交给 Binder 排除。
    // 于是常驻记忆 (规则/关键事实) 只会在会话首轮进一次, 之后的轮次只补真正的新条目。
    const bound = binder.injectFor(scope, text, [...prior.ids]);
    if (!bound && !pending) {
      // 三种"没内容"必须分开记, 否则账本给出误导性读数:
      //   skipped     —— 触发策略主动不注入 (同话题重复 / 无信号);
      //   nothing-new —— 选中了条目但全被判重挡掉 (差量注入的正常结果);
      //   empty       —— 压根没选中任何东西 (库里没有 / 没有通道可走)。
      const declined = binder.lastTriggerDecision();
      const byPolicy = declined?.mode === "skip-similar" || declined?.mode === "skip-no-signal";
      record(byPolicy ? "skipped" : binder.lastSelectedIds().length ? "nothing-new" : "empty");
      return decision;
    }
    // ⚠ 只有指引、没有条目时**仍然发一个块** (保底不得被"这块没有内容"吃掉)。
    // 为什么这必须成立: 库里还没有常驻条目、绑定也没命中的会话是**最常见的新用户状态** ——
    // 若把指引挂靠在条目块上, 这些会话里模型就完全不知道 memory_search 存在, 于是永远
    // 攒不下第一条记忆 (r00155cdb954e41c7: 保底通道不得依赖模型自觉)。
    // 形态上它仍是**一个块** (标题 + 指引 + 入口), 与"注入了2次"无关。
    // 块组装收口在 kernel/format-frame.ts 的 composeMemoryBlock (标题 + 框架句 + 指引 + 条目 + 入口)。
    // 框架句与末尾入口必须与记忆内容**同块**: 分开写,"证据"语义与"还能再查"的入口都会丢
    // (实测没有入口时 memory_search 调用率 0/7440)。
    // 负面/纠正提示: **只在真的命中时**才产生内容 (未命中是同步 undefined, 零开销)。
    // 拿到它就把它并进**同一个块** —— 另发一条消息就是用户实测过的"注入了2次"。
    const negativeHint = (await options.negativeHint?.(text)) ?? "";
    if (!bound && !pending && !negativeHint) {
      // 三者皆空: 与上面那次"没内容"同一种处置 (但分开判定 —— 上面那次是为了放回指引,
      // 这里是因为提示可能**单独**构成一个值得发的块)。
      putBack();
      const d = binder.lastTriggerDecision();
      record(d?.mode === "skip-similar" || d?.mode === "skip-no-signal" ? "skipped" : binder.lastSelectedIds().length ? "nothing-new" : "empty");
      return decision;
    }
    const injectedText = composeMemoryBlock({
      body: bound,
      guidance: pending,
      ...(negativeHint ? { negativeHint } : {}),
      language: language(),
    });
    // 去重: 本批已含, 或会话日志里已经注入过同一块 (跨 step/跨轮) → 跳过。
    // (被跳过的这一轮也把指引放回: 没发出去的块必须保留它的"只发一次"。)
    if (msgs.some((m) => messageTextOf(m) === injectedText)) {
      putBack();
      record("skipped");
      return decision;
    }
    if (prior.texts.has(injectedText)) {
      putBack();
      record("skipped");
      return decision;
    }
    // 本次注入的条目 id 随 source 同行 (2026-09-29): 正文里不再有 id 标记, 省 88 token/块。
    // 实测该扩展字段能通过 session v4 真实准入 (assertV4RowAdmission) 并经受 JSONL 往返。
    // binder.lastInjectedIds() 正是本次真正写出去的那批 id —— 与账本记的是同一个来源。
    const injectedIds = [...binder.lastInjectedIds()];
    const injected = createUserMessage({
      content: [{ type: "text", text: injectedText }],
      source: memoryMessageSource(INJECTION_FORM, injectedIds),
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
    record("injected");
    return { kind: "enter", messages: nextMsgs };
  };
}
