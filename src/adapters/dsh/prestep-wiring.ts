// adapters/dsh/prestep-wiring.ts — 注入与捕获两段事件接线的组装 (从组装根抽出)。
//
// 为什么独立成文件: 组装根触及 400 行上限 (§407 的又一次触发), 而这两段接线是**一件事** 
// "每一轮: 先按当前文本注入, 再按每一轮沉淀"  它们共享同一个上下文来源 (会话 scope),
// 因此放在一起才能让"两处口径必须一致"由结构保证, 而不是靠两处各写一遍再靠注释提醒。
//
// ## 注入侧的确定性 (设计意图, 不是实现细节)
//
// 注入不经模型自觉: `makePreStepHandler` 是 waterfall 钩子, 在 `next()` 之后把记忆块**追加**
// 进 decision.messages (权威写法见 @deepseek-ai/dsh-agent-instructions)。因此"注入与否"
// 由代码判定  这是本仓 r00155cdb954e41c7 的落实 (保底通道不得依赖模型自觉)。
//
// ## 顺序 (负面提示必须排在记忆块**之后**)
//
// 命中负面/纠正信号时, 先发"当下提示"再发历史教训  提示是**此刻**最该看的东西,
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
import { attachExternalHost } from "./external-bridge.ts";

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
  /** 记忆根。外置宿主的 canonical 落在 <root>/external。 */
  root: string;
  /** 负面/纠正信号面 (可选; 命中即注入"当下提示")。 */
  negativity?: NegativityWiring;
  /** 会话登记的运行时自检 (每步调用, 内部只执行一次)。 */
  checkRegistration?: () => void;
  /**
   * 对话内回执的投递 (**按 session**, 可选)。
   *
   * 为什么签名带 sessionId 而不是裸函数: 回执必须发进**它自己那条对话** 
   * 多会话并发时"猜一个 agent"会把消息发到别人的对话里 (见 receipt.ts 的说明)。
   */
  sendReceipt?: (sessionId: string, r: { summary: string; text?: string }) => void;
}

export function wirePrestepAndCapture(deps: PrestepWiringDeps): void {
  const { ctx, binder, runtime, settings } = deps;
  const external = attachExternalHost({
    ctx,
    root: deps.root,
    projectKey: () => runtime.scope()?.project || runtime.project() || "",
  });

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
      scopeOf: (payload) => {
        const scope = deps.scopeOf(payload.agent.session) ?? payload.agent.session.id;
        // ⚠ 2026-10-06: **顺手把它记进 runtime**  这是 scope 在生产里唯一可靠的来源。
        // 为什么 (真实故障): runtime.lastProject/lastLineage 此前只有 onSessionStart 一个写入点,
        // 而那个钩子依赖的宿主事件在当前 0.2.0 宿主下从未触发 (实测流水里 0 次),
        // 于是 memory_search 的 scope 恒空 + scopeRequired: true ⇒ 1160/1273 条项目内记忆
        // 被整批排除 (13/24 次检索返回空, 含 memory_save 成功后 8 秒就查不到那一次)。
        // 预步是**每步都跑**的路径, 且手里有完整 session  在这里登记, 工具侧就再也拿得到。
        // 见 docs/memory-failure-audit-20261006.md 第三节。
        if (typeof scope === "object") deps.runtime.rememberScope(scope);
        return scope;
      },
      // 命中即提示 (用户诉求: "别人都骂你了, 你为什么不记住这次的教训")。
      // 只注入**当下提示 + 以往同类纠正**, 不注入本轮的沉淀物 (那条还没落盘)。
      ...(deps.negativity ? { negativeHint: (text: string) => deps.negativity!.hint(text) } : {}),
      // **骂了就发回执** (用户实测: "我骂了以后下属没有任何悔改, 你不把他炒鱿鱼吗?")。
      // 与上面的 negativeHint 分工不同:
      //   · negativeHint 是给**模型**的即时行为指令 (并进注入块, 不改变对话流);
      //   · 这条是给**人**的可见回执 (对话里出现一条消息, 说明"它收到了并在改")。
      // 两者都要: 只有前者, 用户看不到任何反应; 只有后者, 模型不知道该改什么。
      ...(deps.negativity && deps.sendReceipt
        ? {
            // sessionId 由 handler 从 payload 取 (它手里有 agent), 不在这里猜。
            onNegative: (sessionId: string, _text: string, summary: string) => {
              deps.sendReceipt!(sessionId, {
                summary,
                text:
                  summary +
                  "\n本轮已按「用户纠正」沉淀 (见 capture 账本); 回复前先复述理解到的方向。",
              });
            },
            detectNegative: (text: string) => deps.negativity!.capture.detect(text),
          }
        : {}),
      // 判定落账: 写入永远 best-effort (append 不抛), 账本关掉时直接丢弃。
      onDecision: (decision) => {
        if (!settings().scheduleLog) return;
        deps.scheduleLog.append({ at: new Date().toISOString(), ...decision });
      },
      // 会话登记的运行时自检 (只报一次; 见 session-wiring.ts 的 makeRegistrationCheck)。
      // 并进既有 handler 而不是另注册一个监听器  另注册会抢 handlers[0], 破坏既有调用方。
      ...(deps.checkRegistration ? { onStep: deps.checkRegistration } : {}),
      externalPreface: (input) => external.preface(input),
    }) as never,
  );

  // 捕获: DSH 的真实 SessionEvent 是内部联合类型, 这里用宽松结构接收 (仿 ReMe)。
  ctx.on("session/event", (session: unknown, event: unknown) => {
    void external.onSessionEvent(session, event).catch((error: unknown) => deps.logWarn("external retain failed: %s", error));
    void runtime
      .capture(session as SessionLike, event as SessionEventLike)
      .catch((error: unknown) => deps.logWarn("capture failed: %s", error));
  });
}
