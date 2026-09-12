// tests/s2/settings-live.test.ts — 设置必须**实时生效**, 而不是重启后才生效。
//
// 真实缺陷: 部分设置只在插件构造时读一次 (autoEvolve / captureEpisodes / episodeRetentionDays),
// 于是面板里改完当轮不生效 —— 这正是用户报告的"只有重启才更新"。
// 本测试逐个钉住: 改设置后**不重启**就必须生效。
import { describe, expect, it, afterEach } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply } from "../../src/adapters/dsh/index.ts";
import { FileBackend } from "../../src/storage/file-store.ts";
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

  it("injectMode: 面板改成 first 后预步**当轮**就停止注入 (不重启)", async () => {
    root = mkdtempSync(join(tmpdir(), "hxmem-live3-"));
    // 造一条真实可注入的记忆 + 一条绑定 (与"给项目配了绑定"的真实形态一致):
    // 没有可注入内容时两种模式都"看不出区别", 那样的断言等于没测。
    const seed = new FileBackend({ root });
    seed.add({
      id: "rLive",
      kind: "rule",
      scope: "global",
      content: "所有容器都要显式设计并发上限",
      source: "t",
      ts: { validAt: "2026-01-01T00:00:00.000Z", assertedAt: "2026-01-01T00:00:00.000Z" },
      confirmedBy: "u",
      confirmedAt: "t",
    });
    seed.close();
    writeFileSync(
      join(root, "bindings.json"),
      JSON.stringify([
        { project: "api", bindings: [{ id: "cross-rules", query: { kind: "rule", scope: "global" } }] },
      ]),
    );

    const current = { value: baseSettings({ injectMode: "every-turn" }) };
    const { ctx, update } = makeCtx(current);
    apply(ctx as never, { root });
    const preStep = ctx.handlers.get("agent/pre-step")?.[0] as
      | ((payload: unknown, next: () => Promise<unknown>) => Promise<unknown>)
      | undefined;
    expect(preStep, "插件必须挂上 agent/pre-step").toBeDefined();

    // 会话里已经有一条**其它**条目的记忆块 (基线非空, 但没有 rLive) —— first 模式据此关闸。
    const session = {
      id: "s1",
      header: { cwd: "/code/api" },
      events: [
        {
          type: "user/message",
          data: {
            source: { kind: "plugin", plugin: "hx-memory", form: "instructions" },
            content: [{ type: "text", text: "- [rOther] 别的记忆 <!--hx-memory:id=rOther-->" }],
          },
        },
      ],
    };
    const claimed = [
      { role: "user", source: { kind: "user" }, content: [{ type: "text", text: "继续这个话题" }] },
    ];
    const payload = { agent: { session }, messages: claimed, step: 3 };
    const run = () => preStep!(payload, async () => ({ kind: "enter", messages: claimed }));
    const textOf = (d: unknown) =>
      JSON.stringify((d as { messages: unknown[] }).messages);

    const everyTurn = await run();
    expect(textOf(everyTurn), "every-turn: 新条目 (rLive) 仍然补进来").toContain("并发上限");

    update({ injectMode: "first" });
    const firstMode = (await run()) as { messages: unknown[] };
    expect(textOf(firstMode), "改成 first 后当轮就停止注入").not.toContain("并发上限");
    expect(firstMode.messages, "first 短路 → 原样返回 claimed 批次").toBe(claimed);

    // 开关是双向的: 切回 every-turn 必须当轮恢复注入。
    update({ injectMode: "every-turn" });
    expect(textOf(await run())).toContain("并发上限");
  });
});
