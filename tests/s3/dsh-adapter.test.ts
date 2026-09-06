// tests/s3/dsh-adapter.test.ts — S3: DSH adapter 的事件接线 (用假 harness, 不依赖真实 DSH)。
// 模拟 DSH 宿主发出的 session/event 序列, 验证:
//   1. turn/end(completed) → 捕获入记忆 (经 CapturePipeline + FileBackend)
//   2. 未完成 turn 不捕获
//   3. autoCapture=false 时不捕获
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileBackend } from "../../src/storage/file-store.ts";
import { CapturePipeline } from "../../src/capture/pipeline.ts";
import { HxMemoryRuntime, type SessionEventLike } from "../../src/adapters/dsh/runtime.ts";

let root: string;
let store: FileBackend;
let pipe: CapturePipeline;
let runtime: HxMemoryRuntime;

const session = { id: "test-session-1" };

function turnStart(): SessionEventLike {
  return { type: "turn/start", data: { turn: 1 } };
}
function userMsg(text: string): SessionEventLike {
  return { type: "user/message", data: { content: [{ type: "text", text }] } };
}
function turnEnd(reason: string): SessionEventLike {
  return { type: "turn/end", data: { reason: { kind: reason } } };
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "hxmem-s3-"));
  store = new FileBackend({ root });
  pipe = new CapturePipeline(store);
  runtime = new HxMemoryRuntime(pipe, () => ({ autoCapture: true }));
});

afterAll(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

describe("HxMemoryRuntime: session/event 捕获", () => {
  it("completed turn with user message captures a lesson", () => {
    runtime.onSessionStart(session);
    runtime.capture(session, turnStart());
    runtime.capture(session, userMsg("后端队列并发踩坑, 下次注意幂等"));
    runtime.capture(session, turnEnd("completed"));
    const hits = store.query({ kind: "lesson" });
    expect(hits.length).toBeGreaterThanOrEqual(1);
  });

  it("interrupted turn (reason != completed) does NOT capture", () => {
    const before = store.query({}).length;
    runtime.capture(session, turnStart());
    runtime.capture(session, userMsg("这个对话被打断了, 不该记住"));
    runtime.capture(session, turnEnd("interrupted"));
    expect(store.query({}).length).toBe(before);
  });

  it("autoCapture=false ignores events", () => {
    const quiet = new HxMemoryRuntime(pipe, () => ({ autoCapture: false }));
    const before = store.query({}).length;
    quiet.capture(session, turnStart());
    quiet.capture(session, userMsg("记住: 关掉自动捕获时这条不该存"));
    quiet.capture(session, turnEnd("completed"));
    expect(store.query({}).length).toBe(before);
  });

  it("session end clears per-session state", () => {
    runtime.onSessionStart(session);
    runtime.capture(session, turnStart());
    runtime.capture(session, userMsg("记住: X"));
    runtime.onSessionEnd(session);
    // 会话结束后 turn 事件不再有状态可聚合
    runtime.capture(session, turnEnd("completed"));
    expect(store.query({ text: "记住: X" }).length).toBe(0);
  });
});
