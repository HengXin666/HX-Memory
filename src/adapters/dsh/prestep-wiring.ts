// adapters/dsh/prestep-wiring.ts — 注入与捕获两段事件接线的组装 (从组装根抽出)。
//
// 为什么独立成文件: 组装根触及 400 行上限 (§407 的又一次触发), 而这两段接线是**一件事** ——
// "每一轮: 先按当前文本注入, 再按每一轮沉淀" —— 它们共享同一个上下文来源 (会话 scope),
// 因此放在一起才能让"两处口径必须一致"由结构保证, 而不是靠两处各写一遍再靠注释提醒。
//
// ## 注入侧的确定性 (设计意图, 不是实现细节)
//
// 注入不经模型自觉: `makePreStepHandler` 是 waterfall 钩子, 在 `next()` 之后把记忆块**追加**
// 进 decision.messages (权威写法见 @deepseek-ai/dsh-agent-instructions)。因此"注入与否"
// 由代码判定 —— 这是本仓 r00155cdb954e41c7 的落实 (保底通道不得依赖模型自觉)。
//
// ## 顺序 (负面提示必须排在记忆块**之后**)
//
// 命中负面/纠正信号时, 先发"当下提示"再发历史教训 —— 提示是**此刻**最该看的东西,
// 放在后面会被一长串记忆条目淹没。两者的组装在 handler 内部, 这里只负责传判定面进去。
import type { Context } from "@deepseek-ai/cordis";
import type { Binder } from "../../kernel/binder.ts";
import type { ProjectScopeArg } from "../../kernel/project-lineage.ts";
import type { HxMemorySettings } from "./types.js";
import type { HxMemoryRuntime, SessionLike, SessionEventLike } from "./runtime.js";
import type { PendingGuidance } from "./session-start.ts";
import type { ScheduleLog } from "./schedule-log.ts";
import type { NegativityWiring } from "./negativity-wiring.js";
import { makePreStepHandler } from "./prestep.js";

export interface PrestepWiringDeps {
  ctx: Context;
  binder: Binder;
  runtime: HxMemoryRuntime;
  pendingGuidance: PendingGuidance;
  scheduleLog: ScheduleLog;
  settings: () => HxMemorySettings;
  /** 会话 → 工作区上下文 (项目键 + 祖先链)。 */
  scopeOf: (session: SessionLike) => ProjectScopeArg | undefined;
  logWarn: (message: string, error: unknown) => void;
  /** 负面/纠正信号面 (可选; 命中即注入"当下提示")。 */
  negativity?: NegativityWiring;
  /** 会话登记的运行时自检 (每步调用, 内部只执行一次)。 */
  checkRegistration?: () => void;
}

export function wirePrestepAndCapture(deps: PrestepWiringDeps): void {
  const { ctx, binder, runtime, settings } = deps;

  ctx.on(
    "agent/pre-step",
    makePreStepHandler(binder, {
      rootAgentsOnly: () => settings().rootAgentsOnly,
      enabled: () => settings().injectBindings,
      warmupMs: () => settings().semanticWarmupMs,
      language: () => settings().language,
      injectMode: () => settings().injectMode,
      // 指引随首轮记忆块一起发 (同一个块 → 一次会话只注入一次)。
      // 取走即清空, 所以这里不需要任何"是否已发过"的判据。
      pendingGuidance: deps.pendingGuidance,
      // 工作区上下文 (项目键 + 祖先链): 与 session-start / 捕获同口径。
      scopeOf: (payload) => deps.scopeOf(payload.agent.session) ?? payload.agent.session.id,
      // 命中即提示 (用户诉求: "别人都骂你了, 你为什么不记住这次的教训")。
      // 只注入**当下提示 + 以往同类纠正**, 不注入本轮的沉淀物 (那条还没落盘)。
      ...(deps.negativity ? { negativeHint: (text: string) => deps.negativity!.hint(text) } : {}),
      // 判定落账: 写入永远 best-effort (append 不抛), 账本关掉时直接丢弃。
      onDecision: (decision) => {
        if (!settings().scheduleLog) return;
        deps.scheduleLog.append({ at: new Date().toISOString(), ...decision });
      },
      // 会话登记的运行时自检 (只报一次; 见 session-wiring.ts 的 makeRegistrationCheck)。
      // 并进既有 handler 而不是另注册一个监听器 —— 另注册会抢 handlers[0], 破坏既有调用方。
      ...(deps.checkRegistration ? { onStep: deps.checkRegistration } : {}),
    }) as never,
  );

  // 捕获: DSH 的真实 SessionEvent 是内部联合类型, 这里用宽松结构接收 (仿 ReMe)。
  ctx.on("session/event", (session: unknown, event: unknown) => {
    void runtime
      .capture(session as SessionLike, event as SessionEventLike)
      .catch((error: unknown) => deps.logWarn("capture failed: %s", error));
  });
}
