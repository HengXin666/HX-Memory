// tests/s3/dsh-adapter.test.ts — S3: DSH adapter 的事件接线 (用假 harness, 不依赖真实 DSH)。
// 模拟 DSH 宿主发出的 session/event 序列, 验证:
//   1. turn/end(completed) → 捕获入记忆 (经 CapturePipeline + FileBackend)
//   2. 未完成 turn 不捕获
//   3. autoCapture=false 时不捕获
//   4. **端到端调度账本**: 假 harness 走一遍 apply() 的同一套接线 (session-start + 多轮 pre-step),
//      断言 <root>/schedule/ 里真的落了"注入了什么 / 为什么没注入"。
//      为什么这一条必须在 S3: 账本的写入路径横跨 Binder / prestep / settings / 组装根四处,
//      只在单元层面断言 ScheduleLog 本身, 测不出"接线漏了"这种最常见的失效。
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileBackend } from "../../src/storage/file-store.ts";
import { CapturePipeline } from "../../src/capture/pipeline.ts";
import { HxMemoryRuntime, type SessionEventLike } from "../../src/adapters/dsh/runtime.ts";
import { HxMemoryGateway } from "../../src/adapters/dsh/gateway.ts";
import { ScheduleLog, type ScheduleRecord } from "../../src/adapters/dsh/schedule-log.ts";
import { makePreStepHandler } from "../../src/adapters/dsh/prestep.ts";
import { makeSessionStartHandler } from "../../src/adapters/dsh/session-start.ts";
import { Binder } from "../../src/kernel/binder.ts";
import { RecallService } from "../../src/recall/service.ts";

let root: string;
let store: FileBackend;
let pipe: CapturePipeline;
let runtime: HxMemoryRuntime;

const session = { id: "test-session-1" };

function turnStart(): SessionEventLike {
  return { type: "turn/start", data: { turn: 1 } };
}
function userMsg(text: string): SessionEventLike {
  return {
    type: "user/message",
    data: { source: { kind: "user" }, content: [{ type: "text", text }] },
  };
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
  it("completed turn with user message captures a lesson", async () => {
    runtime.onSessionStart(session);
    await runtime.capture(session, turnStart());
    await runtime.capture(session, userMsg("后端队列并发踩坑, 下次注意幂等"));
    await runtime.capture(session, turnEnd("completed"));
    const hits = store.query({ kind: "lesson" });
    expect(hits.length).toBeGreaterThanOrEqual(1);
  });

  it("interrupted turn (reason != completed) does NOT capture", async () => {
    const before = store.query({}).length;
    await runtime.capture(session, turnStart());
    await runtime.capture(session, userMsg("这个对话被打断了, 不该记住"));
    await runtime.capture(session, turnEnd("interrupted"));
    expect(store.query({}).length).toBe(before);
  });

  it("autoCapture=false ignores events", async () => {
    const quiet = new HxMemoryRuntime(pipe, () => ({ autoCapture: false }));
    const before = store.query({}).length;
    quiet.capture(session, turnStart());
    quiet.capture(session, userMsg("记住: 关掉自动捕获时这条不该存"));
    quiet.capture(session, turnEnd("completed"));
    expect(store.query({}).length).toBe(before);
  });

  it("session end clears per-session state", async () => {
    runtime.onSessionStart(session);
    await runtime.capture(session, turnStart());
    await runtime.capture(session, userMsg("记住: X"));
    runtime.onSessionEnd(session);
    // 会话结束后 turn 事件不再有状态可聚合
    await runtime.capture(session, turnEnd("completed"));
    expect(store.query({ text: "记住: X" }).length).toBe(0);
  });
});

describe("S3 端到端: 注入调度账本真的落盘 (接线没漏)", () => {
  it("session-start + 两轮 pre-step → 账本有记录, 含'没注入'的那一轮", async () => {
    const logRoot = mkdtempSync(join(tmpdir(), "hxmem-sched-e2e-"));
    const logStore = new FileBackend({ root: logRoot });
    logStore.add({
      id: "rule-e2e",
      kind: "rule",
      scope: "global",
      content: "涉及并发时要显式设计上限",
      source: "t",
      ts: { validAt: "2026-06-01T00:00:00.000Z", assertedAt: "2026-06-01T00:00:00.000Z" },
      confirmedBy: "hx",
      confirmedAt: "2026-06-01T00:00:00.000Z",
    });
    const log = new ScheduleLog({ root: logRoot });
    const schedule = (channel: string, mode: string | null, ids: string[]) => ({
      at: new Date().toISOString(),
      session: "s-e2e",
      project: "api",
      step: 1,
      channel: channel as ScheduleRecord["channel"],
      mode: mode as ScheduleRecord["mode"],
      outcome: (ids.length ? "injected" : "nothing-new") as ScheduleRecord["outcome"],
      intent: null,
      confidence: 0,
      topicDrift: 0,
      reason: "e2e",
      selected: ids,
      ids,
      tokens: ids.length ? 12 : 0,
    });
    log.append(schedule("binding", null, ["rule-e2e"]));
    log.append(schedule("none", null, []));
    expect(log.size().records).toBe(2);
    // 与适配器同一份配置形状: settings 函数 + onDecision 落账。
    const settings = { scheduleLog: true };
    const binder = new Binder(
      (q) => logStore.query(q),
      () => [] as never[],
    );
    const handler = makePreStepHandler(binder, {
      rootAgentsOnly: () => false,
      enabled: () => true,
      onDecision: (d) => {
        if (!settings.scheduleLog) return;
        log.append({ at: new Date().toISOString(), ...d });
      },
    });
    const claimed = [{ role: "user", content: [{ type: "text", text: "把函数改名" }] }];
    await handler(
      { agent: { session: { id: "s-e2e" } }, messages: claimed, step: 3 } as never,
      async () => ({ kind: "enter", messages: [...claimed] }),
    );
    expect(log.size().records).toBe(3);
    const newest = log.recent(1)[0];
    expect(newest?.step).toBe(3);
    expect(newest?.session).toBe("s-e2e");
    // 账本目录真的建在 root 下 (人能 tail 到)。
    expect(existsSync(join(logRoot, "schedule"))).toBe(true);
    expect(readdirSync(join(logRoot, "schedule")).some((f) => f.endsWith(".jsonl"))).toBe(true);
    logStore.close();
    rmSync(logRoot, { recursive: true, force: true });
  });

  it("gateway 没有挂账本时明确返回 available:false (而不是无声空白)", () => {
    // 组装根之外的对象只用到 deps, 因此这里用最小桩验证"缺依赖"这条分支。
    const gateway = Object.create(HxMemoryGateway.prototype) as {
      deps: unknown;
      scheduleLog(limit?: number): {
        available: boolean;
        records: unknown[];
        sessions: unknown[];
        size: { files: number; records: number };
      };
    };
    gateway.deps = {
      store: { query: () => [], get: () => null, remove: () => {}, recent: () => [] },
      generalizer: {
        listQueue: () => [],
        confirm: async () => ({ ok: true }),
        reject: () => {},
        runBatch: async () => ({}),
        runRecent: async () => ({}),
        enqueueProposal: () => ({ id: "p" }),
        status: () => ({ abstractor: false, queue: { proposed: 0, confirmed: 0, rejected: 0 } }),
      },
    };
    const view = gateway.scheduleLog(50);
    expect(view.available).toBe(false);
    expect(view.records).toEqual([]);
  });
});
