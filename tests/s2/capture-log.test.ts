// tests/s2/capture-log.test.ts — 捕获耗时账本: "沉淀花了多久 / 为什么没沉淀" 必须落盘且可查。
//
// 为什么必须有这些断言: 捕获对宿主是异步的 (index.ts 用 void 丢掉, DSH 的事件派发也不 await),
// 但它与对话同进程同 event loop, 且自己会调一次 LLM 做结构化。于是"这一轮怎么比平时慢"
// 在证据上此前完全无法回答 —— 唯一的计时证据是宿主日志里的一行 ctx.logger, 与"哪一轮对不上号",
// 重启后也拿不到。这些断言把"能回答"变成可执行事实。
//
// 最后两条测的是**不变量**而不是功能: 账本写入是 best-effort, 且关掉它不许改变捕获行为。
// 一个"自己会把对话拖垮"的观测装置比没有观测更糟。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CaptureLog, parseCaptureRecord, type CaptureRecord } from "../../src/adapters/dsh/capture-log.ts";
import { FileBackend } from "../../src/storage/file-store.ts";
import { CapturePipeline } from "../../src/capture/pipeline.ts";
import { HxMemoryRuntime } from "../../src/adapters/dsh/runtime.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hxmem-capture-log-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function record(over: Partial<CaptureRecord> = {}): CaptureRecord {
  return {
    at: "2026-06-01T10:00:00.000Z",
    session: "s1",
    turn: 1,
    outcome: "stored",
    entries: 1,
    qChars: 12,
    aChars: 34,
    episodeMs: 1,
    enrichMs: 2,
    linkMs: 3,
    storeMs: 4,
    totalMs: 10,
    ...over,
  };
}

/** 走一轮完整的问答 (与真实宿主同形状: turn/start → user/message → turn/end)。 */
async function turn(
  runtime: HxMemoryRuntime,
  session: { id: string },
  text: string,
  answer = "好的",
  turnNo = 1,
) {
  await runtime.capture(session, { type: "turn/start", data: { turn: turnNo } });
  await runtime.capture(session, {
    type: "user/message",
    data: { source: { kind: "user" }, content: [{ type: "text", text }] },
  });
  await runtime.capture(session, {
    type: "assistant/message",
    data: { turn: 1, step: 1, message: { role: "assistant", content: [{ type: "text", text: answer }] } },
  });
  await runtime.capture(session, {
    type: "turn/end",
    data: { turn: turnNo, reason: { kind: "completed" } },
  });
}

describe("CaptureLog: 追加与读取", () => {
  it("按天分文件, 追加而不是改写", () => {
    const log = new CaptureLog({ root });
    log.append(record({ at: "2026-06-01T10:00:00.000Z", turn: 1 }));
    log.append(record({ at: "2026-06-02T10:00:00.000Z", turn: 2, session: "s2" }));
    expect(log.size().files).toBe(2);
    expect(log.size().records).toBe(2);
    const tail = log.recent(10);
    expect(tail[0]?.session).toBe("s2"); // 新→旧
    expect(tail[1]?.turn).toBe(1);
  });

  it("坏行只跳过, 不让整份账本不可读", () => {
    const log = new CaptureLog({ root });
    log.append(record());
    const file = join(log.dirPath, "2026-06-01.jsonl");
    const before = readFileSync(file, "utf8");
    require("node:fs").writeFileSync(file, before + "{ not json\n");
    expect(log.recent(10).length).toBe(1);
  });

  it("单日行数上限: 到顶就拒写 (账本不许长成拖垮宿主的东西)", () => {
    const log = new CaptureLog({ root, maxLinesPerDay: 2 });
    expect(log.append(record({ turn: 1 }))).toBe(true);
    expect(log.append(record({ turn: 2 }))).toBe(true);
    expect(log.append(record({ turn: 3 }))).toBe(false);
  });

  it("保留期按整天文件清理; 0 = 永久", () => {
    const log = new CaptureLog({ root, retentionDays: 3 });
    log.append(record({ at: "2026-06-01T10:00:00.000Z" }));
    log.append(record({ at: "2026-06-10T10:00:00.000Z" }));
    expect(log.prune("2026-06-11T00:00:00.000Z")).toBe(1);
    expect(log.size().files).toBe(1);
    const forever = new CaptureLog({ root, retentionDays: 0 });
    expect(forever.prune("2030-01-01T00:00:00.000Z")).toBe(0);
    expect(forever.size().files).toBe(1);
  });

  it("写失败 best-effort: 不抛错, 只置可观测标志", () => {
    // root 指向一个普通文件: mkdir 必然失败, 且是确定性不可写 (不用 /proc, 那会挂住)。
    const asFile = join(root, "not-a-dir");
    require("node:fs").writeFileSync(asFile, "x");
    const log = new CaptureLog({ root: asFile });
    expect(() => log.append(record())).not.toThrow();
    expect(log.append(record())).toBe(false);
    expect(log.hasWriteFailed()).toBe(true);
  });

  it("写出去的行能被 parseCaptureRecord 原样读回", () => {
    const log = new CaptureLog({ root });
    const original = record({ skip: "no-conclusion", entries: 0, detail: "no-conclusion:question" });
    log.append(original);
    const back = log.recent(1)[0]!;
    expect(back).toEqual(original);
    expect(parseCaptureRecord("{ bad")).toBe(null);
    expect(parseCaptureRecord("")).toBe(null);
  });
});

describe("CaptureLog: 汇总 (分位数, 不是平均)", () => {
  it("p50/p95/max 与分阶段均值按记录算", () => {
    const log = new CaptureLog({ root });
    for (let i = 1; i <= 20; i++) {
      log.append(record({ turn: i, totalMs: i, enrichMs: i * 2, storeMs: 1 }));
    }
    const stats = log.stats(100);
    expect(stats.count).toBe(20);
    expect(stats.totalMs.p50).toBe(10);
    expect(stats.totalMs.p95).toBe(19);
    expect(stats.totalMs.max).toBe(20);
    expect(stats.mean.storeMs).toBe(1);
    // 最慢的一条必须能被指出来 —— 只给汇总回答不了"是哪一轮"。
    expect(stats.slowest?.turn).toBe(20);
  });

  it("跳过的轮次不进耗时统计, 但要能被计数 (它是'为什么没沉淀'的答案)", () => {
    const log = new CaptureLog({ root });
    log.append(record({ turn: 1, outcome: "stored", totalMs: 100 }));
    log.append(record({ turn: 2, outcome: "skipped", skip: "no-turn", totalMs: 0, entries: 0 }));
    log.append(record({ turn: 3, outcome: "skipped", skip: "disabled", totalMs: 0, entries: 0 }));
    const stats = log.stats(100);
    expect(stats.count).toBe(1);
    expect(stats.skipped).toBe(2);
    expect(stats.totalMs.max).toBe(100);
  });
});

describe("运行时接线: 每一轮都留下依据", () => {
  function runtimeWith(log: CaptureLog | null, interval = 1, extra: Record<string, unknown> = {}) {
    const store = new FileBackend({ root });
    const rt = new HxMemoryRuntime(new CapturePipeline(store), () => ({
      autoCapture: true,
      autoMemoryInterval: interval,
      ...extra,
    }), { captureLog: () => log });
    return { rt, store };
  }

  it("落盘的轮次记 stored + 各段耗时 + 宿主给的轮次号", async () => {
    const log = new CaptureLog({ root });
    const { rt, store } = runtimeWith(log);
    const session = { id: "s1" };
    rt.onSessionStart(session);
    await turn(rt, session, "踩坑: 并发要加锁", "好的，记下了", 7);
    const r = log.recent(1)[0]!;
    expect(r.outcome).toBe("stored");
    expect(r.entries).toBe(1);
    expect(r.turn).toBe(7); // 与 episode/会话日志对得上
    expect(r.qChars).toBeGreaterThan(0);
    // totalMs 必须覆盖 episodes + enrich + link + store 四段, 不能只等于其中一段。
    expect(r.totalMs).toBeGreaterThanOrEqual(r.enrichMs + r.linkMs + r.storeMs);
    store.close();
  });

  it("问句读不出结论 → 记 no-conclusion 而不是静默消失", async () => {
    const log = new CaptureLog({ root });
    const { rt, store } = runtimeWith(log);
    const session = { id: "s1" };
    rt.onSessionStart(session);
    // 疑问句 + 有回答 → 走提炼闸门; 启发式结构化器刻意不产 conclusion → 不落盘。
    await turn(rt, session, "这个要不要改成异步的?", "可以讨论一下", 1);
    const r = log.recent(1)[0]!;
    expect(r.outcome).toBe("skipped");
    expect(r.skip).toBe("no-conclusion");
    store.close();
  });

  it("没有形成问答的 turn/end → 记 no-turn (解释那段空白)", async () => {
    const log = new CaptureLog({ root });
    const { rt, store } = runtimeWith(log);
    const session = { id: "s1" };
    rt.onSessionStart(session);
    await rt.capture(session, { type: "turn/end", data: { turn: 3, reason: { kind: "aborted" } } });
    const r = log.recent(1)[0]!;
    expect(r.skip).toBe("no-turn");
    store.close();
  });

  it("关掉捕获 / subagent 会话的轮次也要留下原因", async () => {
    const log = new CaptureLog({ root });
    const { rt, store } = runtimeWith(log, 1, { autoCapture: false });
    const session = { id: "s1" };
    rt.onSessionStart(session);
    await rt.capture(session, { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } });
    expect(log.recent(1)[0]?.skip).toBe("disabled");
    store.close();

    const log2 = new CaptureLog({ root });
    const { rt: rt2, store: store2 } = runtimeWith(log2);
    const sub = { id: "sub", header: { origin: "subagent" } };
    rt2.onSessionStart(sub);
    await turn(rt2, sub, "踩坑: 子 agent 的任务");
    expect(log2.recent(1)[0]?.skip).toBe("subagent");
    store2.close();
  });

  it("落盘抛错记 error 行 (那段安静不能读成'很顺')", async () => {
    const log = new CaptureLog({ root });
    const store = new FileBackend({ root });
    const rt = new HxMemoryRuntime(new CapturePipeline(store), () => ({
      autoCapture: true,
      autoMemoryInterval: 1,
    }), { captureLog: () => log, onError: () => undefined });
    const session = { id: "s1" };
    rt.onSessionStart(session);
    store.close(); // 让后续写入必然失败
    await turn(rt, session, "踩坑: 这轮会写失败");
    const r = log.recent(1)[0]!;
    expect(r.outcome).toBe("error");
    expect(r.detail ?? "").not.toBe("");
  });

  it("不注入账本时行为完全不变 (观测装置不许成为依赖)", async () => {
    const { rt, store } = runtimeWith(null);
    const session = { id: "s1" };
    rt.onSessionStart(session);
    await turn(rt, session, "踩坑: 并发要加锁");
    expect(store.query({}).length).toBe(1);
    // 磁盘上不该出现 capture 目录。
    expect(readdirSync(root).filter((n) => n === "capture").length).toBe(0);
    store.close();
  });
});
