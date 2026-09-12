// tests/s2/qa-pair-capture.test.ts — S2: 捕获单元是"一轮问答", 不是"一句用户输入"。
//
// 背景 (2026-09 实测): episode 日志里 107 条全是 role:user, 助手侧一条都没有;
// 79 条记忆里 15% 是问句本身。根因是 runtime 只监听 user/message 且 role 硬编码。
// 本文件钉住修复后的三条不变量: ①助手输出进日志且 role 正确; ②记忆吃 {question, answer};
// ③血缘同时指向两条 episode。
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileBackend } from "../../src/storage/file-store.ts";
import { EpisodeStore } from "../../src/storage/episode-store.ts";
import { CapturePipeline } from "../../src/capture/pipeline.ts";
import { HxMemoryRuntime } from "../../src/adapters/dsh/runtime.ts";
import type { TurnStructurer } from "../../src/capture/structurer.ts";

let root: string;
let store: FileBackend;
let episodes: EpisodeStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hxmem-qapair-"));
  store = new FileBackend({ root });
  episodes = new EpisodeStore({ root });
});
afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

/** 一轮问答: user/message + assistant/message + turn/end。 */
async function turn(
  runtime: HxMemoryRuntime,
  session: { id: string },
  question: string,
  answer: string,
): Promise<void> {
  await runtime.capture(session, { type: "turn/start", data: {} });
  await runtime.capture(session, {
    type: "user/message",
    data: { source: { kind: "user" }, content: [{ type: "text", text: question }] },
  });
  await runtime.capture(session, {
    type: "assistant/message",
    data: { content: [{ type: "text", text: answer }] },
  });
  await runtime.capture(session, { type: "turn/end", data: { reason: { kind: "completed" } } });
}

function mkRuntime(structurer?: TurnStructurer): HxMemoryRuntime {
  return new HxMemoryRuntime(
    new CapturePipeline(store, structurer ? { structurer } : {}),
    () => ({ autoCapture: true, autoMemoryInterval: 1 }),
    { episodes: () => episodes, surface: "dsh" },
  );
}

describe("episode: 助手输出必须进日志且 role 正确", () => {
  it("一轮写两条 episode, role 分别是 user / assistant", async () => {
    const runtime = mkRuntime();
    const session = { id: "s1" };
    runtime.onSessionStart(session);
    await turn(runtime, session, "默认多少秒?", "改成 60 秒。");
    const all = episodes.all();
    expect(all.map((e) => e.role)).toEqual(["user", "assistant"]);
    expect(all.map((e) => e.text)).toEqual(["默认多少秒?", "改成 60 秒。"]);
  });

  it("助手那条与用户那条共享同一个 turn 序号 (重放能配对)", async () => {
    const runtime = mkRuntime();
    const session = { id: "s2" };
    runtime.onSessionStart(session);
    await turn(runtime, session, "问题一", "回答一");
    await turn(runtime, session, "问题二", "回答二");
    const all = episodes.all();
    expect(all.map((e) => [e.turn, e.role])).toEqual([
      [1, "user"], [1, "assistant"], [2, "user"], [2, "assistant"],
    ]);
  });

  it("血缘指回两条 episode (用户问 + 助手答)", async () => {
    const runtime = mkRuntime();
    const session = { id: "s3" };
    runtime.onSessionStart(session);
    await turn(runtime, session, "踩坑: 容器并发要显式设上限", "已记下。");
    const entry = store.query({}).find((e) => e.kind === "lesson");
    expect(entry?.derivedFrom?.length).toBe(2);
    const ids = new Set(episodes.all().map((e) => e.id));
    for (const id of entry!.derivedFrom!) expect(ids.has(id)).toBe(true);
  });
});

describe("记忆层: 问句转录被结论取代", () => {
  it("问句轮次落盘的是结论, 不是提问原文", async () => {
    const runtime = mkRuntime({
      async structure(input) {
        return {
          summary: "摘要",
          tags: ["config"],
          points: ["理由"],
          ...(input.answer ? { conclusion: "默认值改为 60 秒并先释放会话" } : {}),
        };
      },
    });
    const session = { id: "s4" };
    runtime.onSessionStart(session);
    await turn(runtime, session, "默认多少秒? 重启前要不要释放会话?", "改成 60 秒, 重启前先释放。");
    const entries = store.query({});
    expect(entries).toHaveLength(1);
    expect(entries[0]!.content).toBe("默认值改为 60 秒并先释放会话");
    expect(entries[0]!.content).not.toContain("默认多少秒");
  });

  it("讨论不出结论的轮次不落盘 (只剩噪声时不写)", async () => {
    const runtime = mkRuntime({
      async structure() {
        return { summary: "摘要", tags: [], points: [] }; // 无 conclusion
      },
    });
    const session = { id: "s5" };
    runtime.onSessionStart(session);
    await turn(runtime, session, "这个是不是有问题?", "还需要再看看。");
    expect(store.query({})).toHaveLength(0);
    // 但原文必须还在 (真相不丢)
    expect(episodes.all()).toHaveLength(2);
  });
});
