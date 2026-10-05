// src/adapters/dsh/session-start.ts — 会话开始时的**登记** (不注入)。
//
// 为什么独立成模块: index.ts 是**组装根** (只接线, 不装策略), 而"会话开始时做什么"
// 本身就是一段有判定的策略 (subagent 过滤 / 开关 / 判重)。
// 它此前长在 index.ts 里, 把组装根顶过了仓库的 400 行上限 (verify-structure) ——
// 上限的用意正是"超过 400 行通常是两个职责被塞进了一个文件"。
//
// ⚠ **这里不再注入任何东西** (2026-09, 用户实测 "别注入2次, 就只能注入一次"):
// 此前本模块发"指引"、pre-step 发"条目", 一次会话里模型读到两块 HX-Memory 内容。
// 现在**唯一的注入点是 pre-step** (见 prestep.ts 的"单一注入点"注释): 指引与条目被组装进
// 同一个块, 一次会话里只出现一次。
//
// 那为什么这个模块还留着: 会话开始仍然要做一件**只有这里能做**的事 —— 把指引**塞进 agent**,
// 让它在**首轮预步**时随块发出。理由是预步才是"知道用户问什么"的时刻:
//   · 指引说一次就够, 且它必须与条目同块 (分开就是两块, 正是用户要消掉的形态);
//   · 条目按真实用户文本排序/裁预算, 比"会话开始时还不知道要问什么"更准。
// 因此本模块的产出是"给 agent 挂上一段待发指引", 而不是一条已注入的消息。
import { memoryGuidance } from "./guidance.js";
import type { SessionLike } from "./runtime.js";

/** 会话开始 payload 里本模块用到的面 (其余字段不碰)。 */
export interface SessionStartAgent {
  session: SessionLike;
}

export interface SessionStartDeps {
  /** 当前设置快照 (每次求值, 面板改动当轮生效)。 */
  settings: () => { rootAgentsOnly: boolean; injectGuidance: boolean; language: "zh" | "en" };
  /** 待发指引的容器 (每次会话开始重置一次; 由组装根注入)。 */
  pending: PendingGuidance;
}

/**
 * 待发指引 (会话级): 会话开始时装入, 首轮预步取走后清空。
 *
 * 为什么用容器而不是直接写进会话: 写进会话就是"注入" —— 而注入必须**只**发生在预步那一个点。
 * 容器还有一个副作用是正面的: 取走即清空, 于是"指引只出现一次"由数据形状保证,
 * 不依赖任何一处的判重条件写对。
 *
 * 按 session id 分桶: 同进程多会话并存 (DSH 的 subagent/并发步) 时不会互相顶掉。
 */
export interface PendingGuidance {
  set(sessionId: string, text: string): void;
  /** 取走并清空 (首轮预步调用; 已取走或不存在 → 空串)。 */
  take(sessionId: string): string;
  clear(sessionId: string): void;
}

export function createPendingGuidance(): PendingGuidance {
  const bySession = new Map<string, string>();
  return {
    set: (id, text) => {
      bySession.set(id, text);
    },
    take: (id) => {
      const text = bySession.get(id) ?? "";
      bySession.delete(id);
      return text;
    },
    clear: (id) => {
      bySession.delete(id);
    },
  };
}

export function makeSessionStartHandler(deps: SessionStartDeps) {
  return (payload: unknown): void => {
    const agent = (payload as { agent: SessionStartAgent }).agent;
    const settings = deps.settings();
    // subagent 不挂指引: 它拿到的任务提示词由父 agent 组织, 塞记忆反而污染委派语义。
    // 与 runtime.capture 同口径: undefined 视为"过滤 subagent"。
    if (settings.rootAgentsOnly !== false && agent.session.header?.origin === "subagent") return;
    // 判据写在这里而不是预步: 关掉指引后, 预步只发条目块 (仍然是一个块)。
    if (!settings.injectGuidance) return;
    deps.pending.set(agent.session.id, memoryGuidance(settings.language));
  };
}

/**
 * 宿主各版本的**会话开始事件名** (_按新到旧_)。
 *
 * ⚠ **2026-10-05 真实故障**: 0.2.0-rc.2 里 `agent/session-start` **不存在**
 * (全树 grep 0 命中; 0.2.0 的 agent/* 事件全集为 created/disposed/status/pre-step/
 * request/request-error/assistant-stream/turn-stopping/error)。而 cordis 的 `ctx.on`
 * 对未知事件名**静默不报错** (`_hooks[name] ||= []` → 永不触发), 于是插件表面完全正常:
 * fiber active、工具可用、pre-step 注入照跑 —— 只有"会话开始登记"这一支整体哑掉。
 *
 * 后果链 (逐条实测):
 *   · `runtime.onSessionStart` 从不执行 ⇒ lastSessionId/lastProject/lastLineage 恒 undefined;
 *   · `memory_search` 的 `scopeRequired` 因此永远拿不到 scope ⇒ 实测 **0 条**命中 (带 scope 5 条);
 *   · `memory_save` 的来源退化成常量 `session:tool` (真库 10-02 起 6/6 条全退化);
 *   · 指引块永不装入 ⇒ 首轮不再有"可用 memory_search…"那句。
 *
 * 0.2.0 的等价钩子是 `agent/created` (权威范例: `@deepseek-ai/dsh-hooks-claude-code`
 * 用它承接 SessionStart)。两个名字**都注册** (旧名永不触发也无害) 才能同时支持
 * 0.1.7 与 0.2.0 —— 插件声明支持两条通路就要真的都能用。
 */
export const SESSION_START_EVENTS = ["agent/created", "agent/session-start"] as const;
