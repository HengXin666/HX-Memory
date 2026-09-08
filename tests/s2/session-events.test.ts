// tests/s2/session-events.test.ts — 会话事件读取必须跨 DSH 版本可用。
// 坑: 0.1.2-rc.1 移除了 Session.events (改为 eventAt/snapshotEvents/ownEvents),
// 直接读 session.events 会在目标版本上静默拿到 undefined → 去重失效、AI 读不到输出。
// 另一条: 模型可见的是 surface, compaction 遮蔽的事件不能再被当作"已注入"。
import { describe, expect, it } from "vitest";
import { lastEventSeq, sessionEvents } from "../../src/adapters/dsh/session-events.ts";

const ev = (seq: number, text: string, plugin = "hx-memory") => ({
  type: "user/message",
  seq,
  data: { source: { kind: "plugin", plugin }, content: [{ type: "text", text }] },
});

describe("sessionEvents", () => {
  it("0.1.1 形状: 直接读 events 数组", () => {
    const session = { events: [ev(1, "a"), ev(2, "b")] };
    expect(sessionEvents(session).map((e) => e.seq)).toEqual([1, 2]);
  });

  it("0.1.2 形状: 只有 eventAt + surface.nodes", () => {
    const all = new Map([
      [1, ev(1, "a")],
      [2, ev(2, "b")],
      [3, ev(3, "c")],
    ]);
    const session = {
      surface: { nodes: [1, 3] },
      eventAt: (seq: number) => all.get(seq),
    };
    expect(sessionEvents(session).map((e) => e.seq)).toEqual([1, 3]);
  });

  it("surface.nodes 非单调时仍按 seq 升序返回 (compaction 替换会打乱顺序)", () => {
    const all = new Map([
      [2, ev(2, "a")],
      [5, ev(5, "b")],
      [7, ev(7, "c")],
    ]);
    const session = { surface: { nodes: [7, 2, 5] }, eventAt: (seq: number) => all.get(seq) };
    expect(sessionEvents(session).map((e) => e.seq)).toEqual([2, 5, 7]);
  });

  it("0.1.2 形状: 只有 snapshotEvents()", () => {
    const session = { snapshotEvents: () => [ev(1, "a"), ev(2, "b")] };
    expect(sessionEvents(session).map((e) => e.seq)).toEqual([1, 2]);
  });

  it("surface 遮蔽的事件被过滤 (compaction 后不再误判已注入)", () => {
    const session = { events: [ev(1, "a"), ev(2, "b")], surface: { nodes: [2] } };
    expect(sessionEvents(session).map((e) => e.seq)).toEqual([2]);
  });

  it("未知形状返回空数组, 不抛错", () => {
    expect(sessionEvents(undefined)).toEqual([]);
    expect(sessionEvents({})).toEqual([]);
    expect(
      sessionEvents({
        snapshotEvents: () => {
          throw new Error("boom");
        },
      }),
    ).toEqual([]);
  });

  it("lastEventSeq 取最大 seq", () => {
    expect(lastEventSeq({ events: [ev(1, "a"), ev(7, "b")] })).toBe(7);
    expect(lastEventSeq(undefined)).toBe(-1);
  });
});
