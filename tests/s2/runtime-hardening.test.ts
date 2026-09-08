// tests/s2/runtime-hardening.test.ts — 捕获侧的两个回归。
//   1. 只捕获直接用户输入: 插件注入的上下文 (AGENTS.md/time-context/本插件绑定注入) 也是
//      role:user, 混进来就是自捕获 + 噪声;
//   2. 插件卸载时 flushAll 必须冲刷缓冲 (否则 autoMemoryInterval>1 时丢最后几轮)。
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileBackend } from "../../src/storage/file-store.ts";
import { CapturePipeline } from "../../src/capture/pipeline.ts";
import { HxMemoryRuntime } from "../../src/adapters/dsh/runtime.ts";

let root: string;
let store: FileBackend;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hxmem-runtime-hard-"));
  store = new FileBackend({ root });
});
afterEach(() => {
  try {
    store.close();
  } catch {
    // 有的用例故意提前 close 了 store
  }
  rmSync(root, { recursive: true, force: true });
});

const session = { id: "s1" };

function runtime(interval = 1) {
  const rt = new HxMemoryRuntime(new CapturePipeline(store), () => ({
    autoCapture: true,
    autoMemoryInterval: interval,
  }));
  rt.onSessionStart(session);
  return rt;
}

async function userMsg(rt: HxMemoryRuntime, text: string, source: unknown) {
  await rt.capture(session, { type: "turn/start", data: {} });
  await rt.capture(session, {
    type: "user/message",
    data: { source, content: [{ type: "text", text }] },
  });
  await rt.capture(session, { type: "turn/end", data: { reason: { kind: "completed" } } });
}

describe("捕获来源过滤", () => {
  it("直接用户输入会被捕获", async () => {
    const rt = runtime();
    await userMsg(rt, "踩坑: 并发要加锁", { kind: "user" });
    expect(store.query({}).length).toBe(1);
  });

  it("插件注入的上下文不会被捕获 (含本插件自己的注入)", async () => {
    const rt = runtime();
    await userMsg(rt, "AGENTS.md baseline 内容", { kind: "plugin", plugin: "agent-instructions" });
    await userMsg(rt, "【HX-Memory 绑定注入】- [r1] 规则", { kind: "plugin", plugin: "hx-memory" });
    expect(store.query({}).length).toBe(0);
  });
});

describe("subagent 过滤", () => {
  it("rootAgentsOnly 时不捕获 subagent 会话 (它的提示词 source.kind 也是 user)", async () => {
    const rt = new HxMemoryRuntime(new CapturePipeline(store), () => ({
      autoCapture: true,
      rootAgentsOnly: true,
    }));
    const sub = { id: "sub-1", header: { origin: "subagent" as const } };
    rt.onSessionStart(sub);
    await rt.capture(sub, { type: "turn/start", data: {} });
    await rt.capture(sub, {
      type: "user/message",
      data: {
        source: { kind: "user" },
        content: [{ type: "text", text: "踩坑: 子 agent 的任务" }],
      },
    });
    await rt.capture(sub, { type: "turn/end", data: { reason: { kind: "completed" } } });
    expect(store.query({}).length).toBe(0);
  });

  it("rootAgentsOnly=false 时仍可捕获 (显式选择)", async () => {
    const rt = new HxMemoryRuntime(new CapturePipeline(store), () => ({
      autoCapture: true,
      rootAgentsOnly: false,
    }));
    const sub = { id: "sub-2", header: { origin: "subagent" as const } };
    rt.onSessionStart(sub);
    await rt.capture(sub, { type: "turn/start", data: {} });
    await rt.capture(sub, {
      type: "user/message",
      data: {
        source: { kind: "user" },
        content: [{ type: "text", text: "踩坑: 子 agent 的任务" }],
      },
    });
    await rt.capture(sub, { type: "turn/end", data: { reason: { kind: "completed" } } });
    expect(store.query({}).length).toBe(1);
  });
});

describe("落盘失败不能影响宿主", () => {
  it("store 报错时 onError 被调用, flushAll 不抛出", async () => {
    const errors: unknown[] = [];
    const rt = new HxMemoryRuntime(
      new CapturePipeline(store),
      () => ({ autoCapture: true, autoMemoryInterval: 5 }),
      { onError: (e) => errors.push(e) },
    );
    rt.onSessionStart(session);
    await userMsg(rt, "踩坑: 这轮会写失败", { kind: "user" });
    expect(store.query({}).length).toBe(0);
    store.close(); // 让后续写入必然失败
    rt.onSessionEnd(session);
    await expect(rt.flushAll()).resolves.toBeUndefined();
    expect(errors.length).toBeGreaterThanOrEqual(1);
  });
});

describe("flushAll", () => {
  it("插件卸载时冲刷所有会话的缓冲", async () => {
    const rt = runtime(5);
    await userMsg(rt, "踩坑: 卸载前最后一轮", { kind: "user" });
    expect(store.query({}).length).toBe(0);
    await rt.flushAll();
    expect(store.query({}).length).toBe(1);
    expect(store.query({})[0]!.content).toContain("卸载前最后一轮");
  });
});
