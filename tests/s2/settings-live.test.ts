// tests/s2/settings-live.test.ts — 设置必须**实时生效**, 而不是重启后才生效。
//
// 真实缺陷: 部分设置只在插件构造时读一次 (autoEvolve / captureEpisodes / episodeRetentionDays),
// 于是面板里改完当轮不生效 —— 这正是用户报告的"只有重启才更新"。
// 本测试逐个钉住: 改设置后**不重启**就必须生效。
import { describe, expect, it, afterEach } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply } from "../../src/adapters/dsh/index.ts";
import type { HxMemorySettings } from "../../src/adapters/dsh/types.ts";

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
}

/** 可变的"宿主权威设置": 改它等于用户在面板里改设置 (不重启)。 */
function makeCtx(current: { value: HxMemorySettings }) {
  const handlers = new Map<string, Handler[]>();
  let onChange: (() => void) | null = null;
  const ctx: FakeCtx = {
    reflect: { provide: () => () => {} },
    logger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
    effect(fn) {
      const dispose = fn();
      return typeof dispose === "function" ? (dispose as () => unknown) : () => {};
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
      installSection(_owner, _ns, _schema, _entry, hooks) {
        hooks.setSource(() => current.value);
        onChange = hooks.onChange;
      },
    },
    tools: { register: () => () => {} },
    handlers,
  };
  return {
    ctx,
    /** 模拟用户在面板改设置 (宿主会 setSource 之后再调 onChange)。 */
    update(patch: Partial<HxMemorySettings>) {
      current.value = { ...current.value, ...patch };
      onChange?.();
    },
  };
}

let root: string | undefined;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function episodeCount(dir: string): number {
  try {
    return readdirSync(join(dir, "episodes")).filter((f) => f.endsWith(".jsonl")).length;
  } catch {
    return 0;
  }
}

async function runTurn(ctx: FakeCtx, text: string): Promise<void> {
  const session = { id: "s1", header: { cwd: "/code/api" } };
  const start = ctx.handlers.get("agent/session-start")?.[0];
  start?.({ agent: { ctx, session, inject: () => {} } });
  // 注意签名: 插件监听的是 ctx.on("session/event", (session, event) => ...),
  // 不是把两者打包成一个对象 (写成后者会让 capture 静默什么都不做 —— 真实踩过)。
  const capture = ctx.handlers.get("session/event")?.[0];
  await capture?.(session, { type: "turn/start", data: {} });
  await capture?.(session, {
    type: "user/message",
    data: { source: { kind: "user" }, content: [{ type: "text", text }] },
  });
  await capture?.(session, { type: "turn/end", data: { reason: { kind: "completed" } } });
}

const baseSettings = (over: Partial<HxMemorySettings> = {}): HxMemorySettings =>
  ({
    autoCapture: true,
    autoMemoryInterval: 1,
    rootAgentsOnly: true,
    language: "zh",
    injectGuidance: true,
    injectBindings: true,
    autoEvolve: true,
    semanticWarmupMs: 50,
    captureEpisodes: false,
    episodeRetentionDays: 90,
    ...over,
  }) as HxMemorySettings;

describe("设置实时生效 (不重启)", () => {
  it("captureEpisodes: 构造时为 false, 面板改成 true 后**当轮**就写 episode", async () => {
    root = mkdtempSync(join(tmpdir(), "hxmem-live-"));
    const current = { value: baseSettings({ captureEpisodes: false }) };
    const { ctx, update } = makeCtx(current);
    apply(ctx as never, { root });

    await runTurn(ctx, "第一条: 踩坑记录");
    expect(episodeCount(root), "初始关闭时不应写 episode").toBe(0);

    // 用户在面板打开开关 (不重启)
    update({ captureEpisodes: true });
    await runTurn(ctx, "第二条: 踩坑记录");
    expect(episodeCount(root), "改设置后当轮就必须写 episode").toBeGreaterThan(0);
  });

  it("captureEpisodes: 反过来 (true → false) 也必须立即停止写入", async () => {
    root = mkdtempSync(join(tmpdir(), "hxmem-live2-"));
    const current = { value: baseSettings({ captureEpisodes: true }) };
    const { ctx, update } = makeCtx(current);
    apply(ctx as never, { root });

    await runTurn(ctx, "第一条踩坑");
    const before = episodeCount(root);
    expect(before).toBeGreaterThan(0);

    update({ captureEpisodes: false });
    await runTurn(ctx, "第二条踩坑");
    expect(episodeCount(root), "关掉之后不应再写").toBe(before);
  });
});
