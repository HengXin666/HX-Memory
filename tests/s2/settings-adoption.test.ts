// tests/s2/settings-adoption.test.ts — 插件真的用上了宿主设置 (端到端)。
// 断言: apply() 会调 installSection; 接住 setSource 后, 改设置会改变插件行为
// (用 session-start 是否注入指引作为可观察信号)。
import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply } from "../../src/adapters/dsh/index.ts";
import { DEFAULT_SETTINGS, type HxMemorySettings } from "../../src/adapters/dsh/types.ts";
import { FileBackend } from "../../src/storage/file-store.ts";

type Handler = (payload: unknown, next?: unknown) => unknown;

interface FakeCtx {
  reflect: { provide: () => () => void };
  logger: () => { info: () => void; warn: () => void; error: () => void };
  effect: (fn: () => unknown, label?: string) => () => unknown;
  on: (name: string, cb: Handler) => () => void;
  inject: (deps: string[], cb: (ctx: FakeCtx) => void) => void;
  get: () => undefined;
  emit: () => void;
  settings: {
    installSection: (
      owner: unknown,
      ns: string,
      schema: unknown,
      entry: unknown,
      hooks: { setSource: (current: () => unknown) => void; onChange: () => void },
    ) => void;
  };
  tools: { register: (tool: unknown) => () => void };
  handlers: Map<string, Handler[]>;
  /** label → disposer (用于断言卸载时会 await 冲刷)。 */
  disposers: Map<string, () => unknown>;
}

interface Installed {
  ns?: string;
  entry?: unknown;
  setSource?: (current: () => unknown) => void;
}

function makeCtx(installed: Installed): FakeCtx {
  const handlers = new Map<string, Handler[]>();
  const disposers = new Map<string, () => unknown>();
  const ctx: FakeCtx = {
    disposers,
    reflect: { provide: () => () => {} },
    logger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
    effect(fn, label) {
      const dispose = fn();
      const fn2 = typeof dispose === "function" ? (dispose as () => unknown) : () => {};
      if (label !== undefined) disposers.set(label, fn2);
      return fn2;
    },
    on(name, cb) {
      const list = handlers.get(name) ?? [];
      list.push(cb);
      handlers.set(name, list);
      return () => {};
    },
    inject(_deps, cb) {
      cb(ctx);
    },
    get: () => undefined,
    emit: () => {},
    settings: {
      installSection(_owner, ns, _schema, entry, hooks) {
        installed.ns = ns;
        installed.entry = entry;
        installed.setSource = hooks.setSource;
      },
    },
    tools: { register: () => () => {} },
    handlers,
  };
  return ctx;
}

let root: string | undefined;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function startSession(ctx: FakeCtx): { injected: string[] } {
  const injected: string[] = [];
  const handler = ctx.handlers.get("agent/session-start")?.[0];
  handler?.({
    agent: {
      ctx,
      session: { id: "s1", header: { cwd: "/code/api" } },
      inject: (m: unknown) => injected.push(JSON.stringify(m)),
    },
  });
  return { injected };
}

/** 用给定 header 触发 session-start (用于 subagent 过滤断言)。 */
function startSessionWith(ctx: FakeCtx, header: Record<string, unknown>): { injected: string[] } {
  const injected: string[] = [];
  const handler = ctx.handlers.get("agent/session-start")?.[0];
  handler?.({
    agent: {
      ctx,
      session: { id: "s1", header },
      inject: (m: unknown) => injected.push(JSON.stringify(m)),
    },
  });
  return { injected };
}

describe("DSH settings 接入", () => {
  it("调用 installSection, 并把组合配置作为 entry", () => {
    root = mkdtempSync(join(tmpdir(), "hxmem-settings-"));
    const installed: Installed = {};
    const ctx = makeCtx(installed);
    apply(ctx as never, { root, settings: { injectGuidance: false } });
    expect(installed.ns).toBe("hx-memory");
    expect((installed.entry as HxMemorySettings).injectGuidance).toBe(false);
    expect(typeof installed.setSource).toBe("function");
  });

  it("接住 setSource 后, 设置改动会改变插件行为", () => {
    root = mkdtempSync(join(tmpdir(), "hxmem-settings-"));
    const installed: Installed = {};
    const ctx = makeCtx(installed);
    apply(ctx as never, { root });

    // 默认: 注入指引
    expect(startSession(ctx).injected.length).toBe(1);

    // 宿主说 injectGuidance=false → 不再注入
    let current: HxMemorySettings = { ...DEFAULT_SETTINGS, injectGuidance: false };
    installed.setSource?.(() => current);
    expect(startSession(ctx).injected.length).toBe(0);

    // 再打开 → 又注入 (证明每次读取都走 thunk, 而不是一次性快照)
    current = { ...DEFAULT_SETTINGS, injectGuidance: true };
    expect(startSession(ctx).injected.length).toBe(1);
  });

  it("lifecycle disposer 返回 thenable 并被 await (卸载时冲刷缓冲)", async () => {
    root = mkdtempSync(join(tmpdir(), "hxmem-settings-"));
    const store = new FileBackend({ root });
    const installed: Installed = {};
    const ctx = makeCtx(installed);
    apply(ctx as never, { root, store, settings: { autoMemoryInterval: 5 } });

    // 造一轮对话 (interval=5 → 还在缓冲里)
    const sessionEvent = ctx.handlers.get("session/event")?.[0];
    expect(typeof sessionEvent).toBe("function");
    const session = { id: "s1", header: { cwd: "/code/api" } };
    await sessionEvent!(session, { type: "turn/start", data: {} });
    await sessionEvent!(session, {
      type: "user/message",
      data: { source: { kind: "user" }, content: [{ type: "text", text: "踩坑: 卸载前最后一轮" }] },
    });
    await sessionEvent!(session, { type: "turn/end", data: { reason: { kind: "completed" } } });
    expect(store.query({}).length).toBe(0);

    const dispose = ctx.disposers.get("hx-memory.lifecycle()");
    expect(typeof dispose).toBe("function");
    const result = dispose!();
    expect(typeof (result as Promise<unknown>)?.then).toBe("function"); // 必须返回 promise
    await (result as Promise<unknown>);
    expect(store.query({}).length).toBe(1);
    store.close();
  });

  it("会话离开 store 时冲刷缓冲 (session/disposed 接线)", async () => {
    root = mkdtempSync(join(tmpdir(), "hxmem-settings-"));
    const store = new FileBackend({ root });
    const ctx = makeCtx({});
    apply(ctx as never, { root, store, settings: { autoMemoryInterval: 5 } });
    const sessionEvent = ctx.handlers.get("session/event")?.[0];
    const disposed = ctx.handlers.get("session/disposed")?.[0];
    expect(typeof disposed).toBe("function");
    const session = { id: "s1", header: { cwd: "/code/api" } };
    await sessionEvent!(session, { type: "turn/start", data: {} });
    await sessionEvent!(session, {
      type: "user/message",
      data: { source: { kind: "user" }, content: [{ type: "text", text: "踩坑: 会话结束要落盘" }] },
    });
    await sessionEvent!(session, { type: "turn/end", data: { reason: { kind: "completed" } } });
    expect(store.query({}).length).toBe(0);
    disposed!(session);
    // 关键: 立刻 await 卸载 disposer (不 sleep) —— flushAll 必须等到已触发的冲刷。
    await (ctx.disposers.get("hx-memory.lifecycle()")?.() as Promise<unknown>);
    expect(store.query({}).length).toBe(1);
    store.close();
  });

  it("subagent 会话不注入指引 (rootAgentsOnly 默认 true)", () => {
    root = mkdtempSync(join(tmpdir(), "hxmem-settings-"));
    const ctx = makeCtx({});
    apply(ctx as never, { root });
    expect(startSessionWith(ctx, { cwd: "/code/api", origin: "subagent" }).injected.length).toBe(0);
    expect(startSessionWith(ctx, { cwd: "/code/api" }).injected.length).toBe(1);
  });

  it("rootAgentsOnly=false 时 subagent 也注入", () => {
    root = mkdtempSync(join(tmpdir(), "hxmem-settings-"));
    const ctx = makeCtx({});
    apply(ctx as never, { root, settings: { rootAgentsOnly: false } });
    expect(startSessionWith(ctx, { cwd: "/code/api", origin: "subagent" }).injected.length).toBe(1);
  });

  it("宿主只有 register (0.1.1) 时走回退路径并采纳 scope.get()", () => {
    root = mkdtempSync(join(tmpdir(), "hxmem-settings-"));
    let baseSeen: unknown;
    let current: HxMemorySettings = { ...DEFAULT_SETTINGS, injectGuidance: false };
    const ctx = makeCtx({});
    // 覆盖成"只有 register"的旧宿主
    (ctx as unknown as { settings: unknown }).settings = {
      register(ns: string, _schema: unknown, options?: { base?: unknown }) {
        baseSeen = options?.base;
        return {
          get: () => current,
          ns,
        };
      },
    };
    apply(ctx as never, { root });

    // base 是组合配置; 读取走 scope.get()
    expect((baseSeen as HxMemorySettings).injectGuidance).toBe(true);
    expect(startSession(ctx).injected.length).toBe(0); // 宿主说 false
    current = { ...DEFAULT_SETTINGS, injectGuidance: true };
    expect(startSession(ctx).injected.length).toBe(1); // 实时读取, 不是快照
  });

  it("injectBindings 独立控制 pre-step 注入 (与指引开关解耦)", async () => {
    root = mkdtempSync(join(tmpdir(), "hxmem-settings-"));
    const store = new FileBackend({ root });
    store.add({
      id: "r1",
      kind: "rule",
      content: "所有容器都要显式设计并发上限",
      source: "t",
      scope: "global",
      ts: { validAt: "2026-01-01T00:00:00.000Z", assertedAt: "2026-01-01T00:00:00.000Z" },
      confirmedBy: "u",
      confirmedAt: "t",
    });

    const installed: Installed = {};
    const ctx = makeCtx(installed);
    apply(ctx as never, {
      root,
      store,
      bindings: [
        {
          project: "api",
          bindings: [{ id: "cross-rules", query: { kind: "rule", scope: "global" } }],
        },
      ],
    });

    const preStep = ctx.handlers.get("agent/pre-step")?.[0];
    expect(typeof preStep).toBe("function");
    const payload = {
      agent: { session: { id: "s1", header: { cwd: "/code/api" }, events: [] } },
      messages: [{ role: "user", content: [{ type: "text", text: "部署容器, 注意并发" }] }],
      step: 1,
    };
    const run = async () =>
      (await preStep!(payload, async () => ({
        kind: "enter",
        messages: [...payload.messages],
      }))) as {
        kind: string;
        messages: unknown[];
      };

    let current: HxMemorySettings = { ...DEFAULT_SETTINGS, injectBindings: true };
    installed.setSource?.(() => current);
    expect((await run()).messages.some((m) => JSON.stringify(m).includes("并发上限"))).toBe(true);

    current = { ...DEFAULT_SETTINGS, injectBindings: false };
    expect((await run()).messages.some((m) => JSON.stringify(m).includes("并发上限"))).toBe(false);
    store.close();
  });
});
