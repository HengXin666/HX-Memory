// tests/s2/turn-pairing.test.ts — 轮次配对契约: 助手回答不得跨轮累积。
//
// 为什么必须有 (2026-09-18 独立盲审怀疑 + 我方直读状态复现的真实缺陷):
// runtime 在 turn/start 时此前**只重置 messages 不清 answers**, 于是上一轮的回答会带进下一轮。
// 后果不是"少记一条", 而是**错误配对落盘** —— 若某轮在两轮之间结束, 写入的是
// "(本轮的问题 + 上一轮的回答)"。两侧都是真实文本, 事后极难察觉。
//
// 这类缺陷单测最容易漏 (只测单轮永远发现不了), 因此本文件专测**跨轮**行为。
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HxMemoryRuntime } from "../../src/adapters/dsh/runtime.ts";
import { CapturePipeline } from "../../src/capture/pipeline.ts";
import { FileBackend } from "../../src/storage/file-store.ts";

let root = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pairing-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** 直读 runtime 的轮次状态 (验证用; 不触发业务)。 */
function peek(rt: HxMemoryRuntime, sid: string): { messages: string[]; answers: string[] } | undefined {
  const t = (rt as unknown as { turns: Map<string, { messages: string[]; answers: string[] }> }).turns;
  return t.get(sid);
}

async function makeRuntime() {
  const store = new FileBackend({ root });
  const rt = new HxMemoryRuntime(
    new CapturePipeline(store),
    () => ({ autoCapture: true, rootAgentsOnly: true }),
    {},
  );
  const session = { id: "s-pair", header: { origin: "root" }, cwd: root } as never;
  rt.onSessionStart(session);
  return { store, rt, session };
}

describe("轮次配对: 回答不跨轮累积", () => {
  it("**turn/start 必须同时清空 messages 与 answers**", async () => {
    const { store, rt, session } = await makeRuntime();
    await rt.capture(session, { type: "turn/start", data: {} } as never);
    await rt.capture(session, { type: "user/message", data: { source: { kind: "user" }, content: "问题一" } } as never);
    await rt.capture(session, { type: "assistant/message", data: { content: "回答一" } } as never);
    expect(peek(rt, "s-pair")!.answers).toEqual(["回答一"]);

    // 新一轮开始 → 两侧都必须清空
    await rt.capture(session, { type: "turn/start", data: {} } as never);
    const st = peek(rt, "s-pair")!;
    expect(st.messages).toEqual([]);
    expect(st.answers).toEqual([]); // 修复前这里是 ["回答一"] —— 跨轮串台
    store.close();
  });

  it("新一轮只有问题没有回答时, answers 保持为空 (不会拿旧回答顶替)", async () => {
    const { store, rt, session } = await makeRuntime();
    await rt.capture(session, { type: "turn/start", data: {} } as never);
    await rt.capture(session, { type: "user/message", data: { source: { kind: "user" }, content: "问题一" } } as never);
    await rt.capture(session, { type: "assistant/message", data: { content: "回答一" } } as never);

    await rt.capture(session, { type: "turn/start", data: {} } as never);
    await rt.capture(session, { type: "user/message", data: { source: { kind: "user" }, content: "问题二" } } as never);
    const st = peek(rt, "s-pair")!;
    expect(st.messages).toEqual(["问题二"]);
    expect(st.answers).toEqual([]); // 不得携带 "回答一"
    store.close();
  });

  it("同一轮内的多次消息都保留 (重置只发生在 turn/start)", async () => {
    const { store, rt, session } = await makeRuntime();
    await rt.capture(session, { type: "turn/start", data: {} } as never);
    await rt.capture(session, { type: "user/message", data: { source: { kind: "user" }, content: "第一句" } } as never);
    await rt.capture(session, { type: "user/message", data: { source: { kind: "user" }, content: "第二句" } } as never);
    await rt.capture(session, { type: "assistant/message", data: { content: "答一" } } as never);
    await rt.capture(session, { type: "assistant/message", data: { content: "答二" } } as never);
    const st = peek(rt, "s-pair")!;
    expect(st.messages).toEqual(["第一句", "第二句"]);
    expect(st.answers).toEqual(["答一", "答二"]);
    store.close();
  });

  it("插件注入的 user 消息不进 messages (避免自捕获)", async () => {
    const { store, rt, session } = await makeRuntime();
    await rt.capture(session, { type: "turn/start", data: {} } as never);
    // source.kind = "plugin" 的注入不应被当作直接用户输入
    await rt.capture(session, { type: "user/message", data: { source: { kind: "plugin" }, content: "注入的常驻记忆块" } } as never);
    await rt.capture(session, { type: "user/message", data: { source: { kind: "user" }, content: "真正的问题" } } as never);
    expect(peek(rt, "s-pair")!.messages).toEqual(["真正的问题"]);
    store.close();
  });
});
