// tests/s2/store-disposer.test.ts — S2: 插件卸载必须释放 SQLite 句柄 (HMR 前提)。
//
// 背景: 热重载 (cordis HMR) 的语义是 dispose 旧 fiber 再 apply() 一次。apply() 会
// \`new FileBackend({ root })\`, 而它内部 \`new DatabaseSync(...)\` 持有文件描述符。
// 修复前 src/adapters/dsh/ 里没有任何 store.close(), 于是每次热重载漏一个句柄 +
// 叠加 WAL/SHM 争用, 最终 "database is locked"。
//
// 为什么用**文件描述符计数**做判据: "卸载后重开同一 root 仍能跑" 测不出泄漏 ——
// 实测 SQLite 允许未 close 的连接旁边再开一个连接并写入 (POSIX 语义如此), 所以
// reopen 类断言在有无 close 时都通过 (写过一版, 去掉 close 后 4 条全绿, 是假闸门)。
// 真正能分辨的是 fd 数: 打开 N 个 backend → fd 上升, 全部 close → 回落到基线。
import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync, readdirSync, readlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply } from "../../src/adapters/dsh/index.ts";
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
  settings: { installSection: () => void };
  tools: { register: () => () => void };
  handlers: Map<string, Handler[]>;
  disposers: Map<string, () => unknown>;
}

function makeCtx(): FakeCtx {
  const handlers = new Map<string, Handler[]>();
  const disposers = new Map<string, () => unknown>();
  const ctx: FakeCtx = {
    handlers,
    disposers,
    reflect: { provide: () => () => {} },
    logger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
    effect(fn, label) {
      const dispose = fn();
      const fn2 = typeof dispose === "function" ? (dispose as () => unknown) : () => {};
      if (label !== undefined) disposers.set(label, fn2);
      return fn2;
    },
    on() {
      return () => {};
    },
    inject(_deps, cb) {
      cb(ctx);
    },
    get: () => undefined,
    emit: () => {},
    settings: { installSection: () => {} },
    tools: { register: () => () => {} },
  };
  return ctx;
}

/** 该 root 目录下的打开文件描述符数 (Linux /proc)。 */
function fdCountFor(dir: string): number {
  let n = 0;
  for (const fd of readdirSync("/proc/self/fd")) {
    try {
      if (readlinkSync("/proc/self/fd/" + fd).includes(dir)) n++;
    } catch {
      // fd 可能在读取间隙被关闭 —— 忽略。
    }
  }
  return n;
}

let root: string | undefined;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

/** 卸载插件 (cordis 会 await 返回 promise 的 disposer)。 */
async function dispose(ctx: FakeCtx): Promise<void> {
  for (const fn of ctx.disposers.values()) await fn();
}

describe("插件卸载: 释放 store 句柄", () => {
  it("卸载后该 root 的 fd 回落 (句柄真的关了)", async () => {
    root = mkdtempSync(join(tmpdir(), "hxmem-disp-"));
    const ctx = makeCtx();
    apply(ctx as never, { root });
    expect(fdCountFor(root)).toBeGreaterThan(0); // 装了插件就必然持有句柄

    await dispose(ctx);
    expect(fdCountFor(root)).toBe(0); // 卸载必须归还
  });

  it("反复装载/卸载不累积 fd (HMR 会反复重载)", async () => {
    root = mkdtempSync(join(tmpdir(), "hxmem-disp-"));
    for (let i = 0; i < 4; i++) {
      const ctx = makeCtx();
      apply(ctx as never, { root });
      await dispose(ctx);
    }
    // 漏一个句柄就会留下 N 个; 4 轮之后必须仍是 0。
    expect(fdCountFor(root)).toBe(0);
  });

  it("disposer 幂等: 重复卸载不抛 (HMR 会反复 dispose)", async () => {
    root = mkdtempSync(join(tmpdir(), "hxmem-disp-"));
    const ctx = makeCtx();
    apply(ctx as never, { root });
    await dispose(ctx);
    await expect(dispose(ctx)).resolves.not.toThrow();
  });

  it("注入进来的 store 不被关闭 (谁创建谁关闭)", async () => {
    root = mkdtempSync(join(tmpdir(), "hxmem-disp-"));
    const injected = new FileBackend({ root });
    const ctx = makeCtx();
    apply(ctx as never, { root, store: injected });
    await dispose(ctx);

    // 调用方的 store 必须仍然可用 —— 关了就是越权 (它持有 fd)。
    expect(fdCountFor(root)).toBeGreaterThan(0);
    expect(() => injected.query({})).not.toThrow();
    injected.close();
  });

  it("卸载会先冲刷缓冲再关库 (顺序不能反)", async () => {
    root = mkdtempSync(join(tmpdir(), "hxmem-disp-"));
    const ctx = makeCtx();
    apply(ctx as never, { root });
    const lifecycle = ctx.disposers.get("hx-memory.lifecycle()");
    expect(lifecycle).toBeTypeOf("function");
    // disposer 是 async: 必须在 close 之前 await flushAll (flush 还要写库)。
    const out = lifecycle!();
    expect(out).toBeInstanceOf(Promise);
    await out;
  });
});
