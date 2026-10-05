// adapters/dsh/session-wiring.ts — 与会话生命周期相关的事件接线 (从组装根抽出)。
//
// 为什么独立成文件 (§407 行数上限的又一次触发, 与 gateway-mount / settings-wiring 同一理由):
// "哪些宿主事件负责会话登记" 是一段有判定的策略, 而组装根只该负责"把它接上"。
//
// ## 这一层的存在理由是一次真实故障 (2026-10-05)
//
// 0.2.0-rc.2 移除了 `agent/session-start`, 而 `ctx.on` 对未知事件名**静默不报错** ——
// 于是插件表面完全正常 (fiber active / 工具可用 / pre-step 注入照跑), 只有会话登记哑掉。
// 后果链见 session-start.ts 的 SESSION_START_EVENTS 头注 (scope 丢失 ⇒ memory_search 0 条,
// memory_save 来源退化成常量, 指引块永不装入)。
//
// 因此这里除了注册, 还做一件**可观测性**的事: 首次 pre-step 时若会话登记仍未生效
// (sessionId 为空), 就写一条警告 —— 把"静默失效"变成"日志里有一行"。
// 这比装配期抛错更合适: 事件表是宿主的私有面, 插件**看不见**它 (不 import dsh-agent),
// 因此只能在**运行时**发现"注册了但从未触发" —— 而那正是本次故障的形态。
import type { Context } from "@deepseek-ai/cordis";
import type { HxMemoryRuntime } from "./runtime.js";
import type { SessionLike } from "./runtime.js";
import { SESSION_START_EVENTS, type PendingGuidance } from "./session-start.js";

export interface SessionWiringDeps {
  ctx: Context;
  runtime: HxMemoryRuntime;
  /** 会话开始处理器 (见 session-start.ts 的 makeSessionStartHandler)。 */
  onSessionStart: (payload: unknown) => void;
  /** 待发指引容器 (会话离开时回收)。 */
  pendingGuidance: PendingGuidance;
  /** 旁路告警 (best-effort; 日志失败不许影响宿主)。 */
  warn: (message: string) => void;
}

export function wireSessionLifecycle(deps: SessionWiringDeps): void {
  const { ctx, runtime, pendingGuidance } = deps;

  // ── 会话开始: 两个事件名都注册 (见 session-start.ts 的 SESSION_START_EVENTS) ──
  //
  // 幂等: 若某代宿主将来同时触发两个事件, onSessionStart 会被调两次 ——
  // 它自身幂等 (覆写同 id 的 TurnState 与同名的 last* 字段), 因此不额外去重。
  for (const eventName of SESSION_START_EVENTS) {
    ctx.on(eventName, (payload: unknown) => {
      // 会话状态登记与注入分开: 即使不注入 (subagent/关掉指引), runtime 也要开始跟踪这一会话。
      const agent = (payload as { agent?: { session?: SessionLike } }).agent;
      if (!agent?.session) return;
      runtime.onSessionStart(agent.session);
      deps.onSessionStart(payload);
    });
  }

  // ── 会话离开 store: 立即冲刷未落盘的 turn 并回收状态 ──────────────────────────
  // (否则 autoMemoryInterval>1 时, 已结束会话的缓冲会一直留到插件卸载。)
  ctx.on("session/disposed", (session: unknown) => {
    runtime.onSessionEnd(session as SessionLike);
    // 待发指引随会话回收: 没等到首轮预步就结束的会话 (用户秒退/会话被丢弃) 不该把它留在内存里。
    pendingGuidance.clear((session as { id?: string })?.id ?? "");
  });

  // 运行时自检**不另注册 pre-step 监听器**: 那会插进 handlers 数组的第 0 位,
  // 让既有调用方 (`ctx.handlers.get("agent/pre-step")?.[0]`) 拿到我们的探针而不是注入处理器。
  // 那个顺序依赖正是实测被 5 个测试抓到的。自检改为**并入既有 handler 的一次回调** ——
  // 见 prestep-wiring.ts 传入的 onFirstStep。
}

/**
 * 会话登记的**运行时自检** (给 prestep-wiring 在每一步调用; 只报一次)。
 *
 * 为什么需要它: 事件表是宿主的私有面, 插件看不见 (不 import dsh-agent), 因此"注册了但从未
 * 触发"只能在**运行时**发现 —— 而那正是本次 0.2.0 故障的形态 (静默、无报错、fiber 正常)。
 */
export function makeRegistrationCheck(
  runtime: HxMemoryRuntime,
  warn: (message: string) => void,
): () => void {
  let reported = false;
  return () => {
    if (reported) return;
    reported = true;
    // sessionId 为空 = 登记从未执行 ⇒ 事件名不被识别 (或宿主换了名字)。
    if (runtime.sessionId()) return;
    warn(
      "会话登记未生效: 已注册的会话开始事件 (" +
        SESSION_START_EVENTS.join(", ") +
        ") 均未被本代宿主触发 —— 项目 scope 与来源标识将为空 (memory_search 只会返回跨项目内容)。" +
        " 常见成因: 宿主版本改变了会话开始事件名; 见 adapters/dsh/session-start.ts。",
    );
  };
}
