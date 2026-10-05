// tests/s2/session-wiring-events.test.ts — 会话登记的事件名契约 (0.2.0 真实故障的防线)。
//
// 为什么有它 (2026-10-05 实测): 宿主 dsh 0.2.0-rc.2 里 `agent/session-start` **不存在**
// (全树 grep 0 命中), 而 cordis 的 `ctx.on` 对未知事件名**静默不报错** ——
// 于是整条会话登记链路哑掉而插件表面完全正常。后果链 (逐条实测):
//   · runtime.lastSessionId/lastProject/lastLineage 恒 undefined;
//   · memory_search 的 scopeRequired 拿不到 scope ⇒ 0 条命中 (带 scope 5 条);
//   · memory_save 来源退化成常量 `session:tool` (真库 10-02 起 6/6 条全退化)。
//
// 本文件钉住三件事:
//   ① 两个事件名**都注册** (旧宿主用旧名, 新宿主用新名, 双通路真的都能用);
//   ② 登记真的把 runtime 的 last* 填上 (否则下游全空);
//   ③ 登记从未生效时**有告警** (把静默失效变成可见的一行)。
import { describe, expect, it } from "vitest";
import { SESSION_START_EVENTS } from "../../src/adapters/dsh/session-start.ts";
import { makeRegistrationCheck, wireSessionLifecycle } from "../../src/adapters/dsh/session-wiring.ts";
import { HxMemoryRuntime } from "../../src/adapters/dsh/runtime.ts";

/** 最小假 ctx: 只收集 on() 注册的 handler, 与既有测试同形。 */
function fakeCtx() {
  const handlers = new Map<string, Array<(...a: unknown[]) => unknown>>();
  return {
    handlers,
    on(name: string, fn: (...a: unknown[]) => unknown) {
      const list = handlers.get(name) ?? [];
      list.push(fn);
      handlers.set(name, list);
      return () => {};
    },
  };
}

function fakeRuntime() {
  const store = { add: async () => {}, all: async () => [], query: () => [] };
  const pipe = { run: async () => ({ entries: [], deduped: 0, signal: "x" }) };
  return new HxMemoryRuntime(pipe as never, () => ({ autoCapture: true }), {} as never);
}

describe("会话开始事件名 (0.2.0 兼容)", () => {
  it("**新旧两个名字都注册** (少一个就会让一代宿主上的登记整体消失)", () => {
    expect(SESSION_START_EVENTS).toContain("agent/created"); // 0.2.0
    expect(SESSION_START_EVENTS).toContain("agent/session-start"); // 0.1.x
  });

  it("wireSessionLifecycle 真的挂上两个名字 + session/disposed", () => {
    const ctx = fakeCtx();
    const runtime = fakeRuntime();
    wireSessionLifecycle({
      ctx: ctx as never,
      runtime,
      onSessionStart: () => {},
      pendingGuidance: { set() {}, take: () => "", clear() {} },
      warn: () => {},
    });
    for (const name of SESSION_START_EVENTS) {
      expect(ctx.handlers.get(name)?.length, name).toBe(1);
    }
    expect(ctx.handlers.get("session/disposed")?.length).toBe(1);
  });

  it("**注册顺序不破坏既有调用方**: 自检不另注册 pre-step 监听器", () => {
    // 实测教训: 我第一版把自检写成独立的 ctx.on("agent/pre-step"), 它插到 handlers[0],
    // 于是几个按 `[0]` 取注入处理器的测试立刻红 —— 顺序依赖是真实存在的契约。
    const ctx = fakeCtx();
    const runtime = fakeRuntime();
    wireSessionLifecycle({
      ctx: ctx as never,
      runtime,
      onSessionStart: () => {},
      pendingGuidance: { set() {}, take: () => "", clear() {} },
      warn: () => {},
    });
    expect(ctx.handlers.get("agent/pre-step")).toBeUndefined();
  });

  it("两代的事件都能触发登记 (payload 形状一致: { agent: { session } })", () => {
    const ctx = fakeCtx();
    const runtime = fakeRuntime();
    let injected = 0;
    wireSessionLifecycle({
      ctx: ctx as never,
      runtime,
      onSessionStart: () => {
        injected++;
      },
      pendingGuidance: { set() {}, take: () => "", clear() {} },
      warn: () => {},
    });
    const session = { id: "session-X", header: { cwd: "/home/hx/Loli/code/HXLoLis/components/HX-Memory" } };
    for (const name of SESSION_START_EVENTS) {
      const handler = ctx.handlers.get(name)![0]!;
      handler({ agent: { session } });
    }
    expect(injected).toBe(2);
    // 登记真的填上了 runtime 的 last* (下游 scope/来源全靠它)
    expect(runtime.sessionId()).toBe("session-X");
    expect(runtime.project()).toBe("HX-Memory");
    expect(runtime.scope()?.lineage).toContain("HXLoLis");
  });

  it("**payload 缺 session 时安全跳过** (不抛异常拖垮宿主)", () => {
    const ctx = fakeCtx();
    const runtime = fakeRuntime();
    wireSessionLifecycle({
      ctx: ctx as never,
      runtime,
      onSessionStart: () => {},
      pendingGuidance: { set() {}, take: () => "", clear() {} },
      warn: () => {},
    });
    for (const name of SESSION_START_EVENTS) {
      expect(() => ctx.handlers.get(name)![0]!({})).not.toThrow();
    }
    expect(runtime.sessionId()).toBeUndefined();
  });
});

describe("登记失效的运行时自检", () => {
  it("从未登记时**报一次**告警 (把静默失效变成可见的一行)", () => {
    const runtime = fakeRuntime();
    const messages: string[] = [];
    const check = makeRegistrationCheck(runtime, (m) => messages.push(m));
    check();
    check();
    check();
    expect(messages.length).toBe(1); // 只报一次 (每步都报会刷满日志)
    expect(messages[0]).toContain("会话登记未生效");
  });

  it("登记正常时不报 (不能变成每会话一条噪声)", () => {
    const runtime = fakeRuntime();
    runtime.onSessionStart({ id: "s1", header: { cwd: "/home/hx/x" } } as never);
    const messages: string[] = [];
    makeRegistrationCheck(runtime, (m) => messages.push(m))();
    expect(messages).toEqual([]);
  });
});
