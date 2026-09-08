// tests/s2/runtime-batch.test.ts — autoMemoryInterval 批量入记忆 (此前是死配置)。
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
  root = mkdtempSync(join(tmpdir(), "hxmem-batch-"));
  store = new FileBackend({ root });
});
afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

async function turn(runtime: HxMemoryRuntime, session: { id: string }, text: string) {
  await runtime.capture(session, { type: "turn/start", data: {} });
  await runtime.capture(session, {
    type: "user/message",
    data: { source: { kind: "user" }, content: [{ type: "text", text }] },
  });
  await runtime.capture(session, { type: "turn/end", data: { reason: { kind: "completed" } } });
}

describe("autoMemoryInterval", () => {
  it("interval=1 (默认) → 每轮落盘", async () => {
    const runtime = new HxMemoryRuntime(new CapturePipeline(store), () => ({
      autoCapture: true,
      autoMemoryInterval: 1,
    }));
    const session = { id: "s1" };
    runtime.onSessionStart(session);
    await turn(runtime, session, "第一轮踩坑: 并发要加锁");
    expect(store.query({}).length).toBe(1);
  });

  it("interval=2 → 攒够两轮才落盘", async () => {
    const runtime = new HxMemoryRuntime(new CapturePipeline(store), () => ({
      autoCapture: true,
      autoMemoryInterval: 2,
    }));
    const session = { id: "s1" };
    runtime.onSessionStart(session);
    await turn(runtime, session, "第一轮踩坑: 并发要加锁");
    expect(store.query({}).length).toBe(0);
    await turn(runtime, session, "第二轮踩坑: 幂等要加键");
    expect(store.query({}).length).toBe(2); // 两条 turn 各自成条
  });

  it("会话结束冲刷未落盘的 turn", async () => {
    const runtime = new HxMemoryRuntime(new CapturePipeline(store), () => ({
      autoCapture: true,
      autoMemoryInterval: 5,
    }));
    const session = { id: "s1" };
    runtime.onSessionStart(session);
    await turn(runtime, session, "踩坑: 只有一轮, 但会话结束要落盘");
    expect(store.query({}).length).toBe(0);
    runtime.onSessionEnd(session);
    await new Promise((r) => setTimeout(r, 10));
    expect(store.query({}).length).toBe(1);
  });
});
