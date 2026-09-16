// src/adapters/dsh/session-start.ts — 会话开始时的记忆注入 (指引 + 常驻规则/绑定)。
//
// 为什么独立成模块: index.ts 是**组装根** (只接线, 不装策略), 而"会话开始时给什么"
// 本身就是一段有判定的策略 (subagent 过滤 / 开关 / 新旧两条线 / 判重)。
// 它此前长在 index.ts 里, 把组装根顶过了仓库的 400 行上限 (verify-structure) ——
// 上限的用意正是"超过 400 行通常是两个职责被塞进了一个文件"。
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import type { Binder } from "../../kernel/binder.ts";
import type { RecallService } from "../../recall/service.ts";
import { memoryGuidance, MEMORY_PLUGIN_SOURCE } from "./guidance.js";
import { priorInjections } from "./prestep.js";
import type { SessionLike } from "./runtime.js";

/** 会话开始 payload 里本模块用到的面 (其余字段不碰)。 */
export interface SessionStartAgent {
  session: SessionLike;
  inject: (message: unknown) => void;
}

export interface SessionStartDeps {
  binder: Binder;
  recall: Pick<RecallService, "recall">;
  /** 当前设置快照 (每次求值, 面板改动当轮生效)。 */
  settings: () => { rootAgentsOnly: boolean; injectGuidance: boolean; language: "zh" | "en" };
  /** 项目键派生 (与捕获/绑定/召回同一口径, 由组装根注入)。 */
  projectOf: (session: SessionLike) => string;
}

/**
 * 会话开始的注入处理器。
 *
 * 两条线并存 (这是设计, 不是历史包袱):
 *   - 项目**声明了**绑定 → 会话开始就确定性注入绑定集 (不依赖模型自觉), 指引作为工具通道补充;
 *   - 没有绑定 → 指引 + 全局规则召回, 由模型按需调 memory_search (旧线)。
 * 与 pre-step 的分工: 这里建立"已在上下文里"的基线, pre-step 只补差量。
 */
export function makeSessionStartHandler(deps: SessionStartDeps) {
  return (payload: unknown): void => {
    const agent = (payload as { agent: SessionStartAgent }).agent;
    const settings = deps.settings();
    // subagent 不注入指引/绑定: 它拿到的任务提示词由父 agent 组织, 塞记忆反而污染委派语义。
    // 与 runtime.capture 同口径: undefined 视为"过滤 subagent"。
    if (settings.rootAgentsOnly !== false && agent.session.header?.origin === "subagent") return;
    if (!settings.injectGuidance) return;
    const parts: string[] = [];
    // project 的派生由调用方负责 (它已经按 runtime 的同一口径算过) —— 这里收已派生好的键。
    const project = deps.projectOf(agent.session);
    const guidance = memoryGuidance(settings.language);
    const bound = deps.binder.injectFor(project, "");
    if (bound) {
      parts.push(bound);
      parts.push(guidance); // 工具通道作为补充 (VCP Agent 同时有绑定 + 主动检索)
    } else {
      // 旧线: 指引 + 全局规则召回 (靠模型自觉调 memory_search)
      parts.push(guidance);
      const recallOut = deps.recall.recall({ project });
      if (recallOut.rules.length) parts.push(recallOut.injected);
    }
    if (!parts.length) return;
    // 会话历史里已经有本插件的注入块 → 不再灌第二遍。
    // 实测同一会话会出现两份完全相同的指引 (session-start 被触发两次), 而它与预步的注入
    // 此前也无法互相判重 (标题/框架句不同) —— 同一批记忆因此会在一轮里出现两三次。
    const text = parts.join("\n\n");
    if (priorInjections(agent).has(text)) return;
    agent.inject(
      createUserMessage({
        content: [{ type: "text", text }],
        source: { kind: "plugin", plugin: MEMORY_PLUGIN_SOURCE, form: "instructions" },
      }),
    );
  };
}
