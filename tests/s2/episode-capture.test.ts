// tests/s2/episode-capture.test.ts — 接线契约: 捕获时先写原文, 记忆带血缘。
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileBackend } from "../../src/storage/file-store.ts";
import { EpisodeStore } from "../../src/storage/episode-store.ts";
import { CapturePipeline } from "../../src/capture/pipeline.ts";
import { HxMemoryRuntime } from "../../src/adapters/dsh/runtime.ts";

let root: string;
let store: FileBackend;
let episodes: EpisodeStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hxmem-epcapture-"));
  store = new FileBackend({ root });
  episodes = new EpisodeStore({ root });
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

const mk = () =>
  new HxMemoryRuntime(
    new CapturePipeline(store),
    () => ({ autoCapture: true, autoMemoryInterval: 1 }),
    {
      episodes,
      surface: "dsh",
    },
  );

describe("捕获 → Episode 血缘", () => {
  it("先写原文再抽记忆: 记忆的 derivedFrom 指向该 episode", async () => {
    const runtime = mk();
    const session = { id: "s1" };
    runtime.onSessionStart(session);
    await turn(runtime, session, "踩坑: 容器并发要显式设上限");
    const all = episodes.all();
    expect(all.length).toBe(1);
    const entry = store.query({}).find((e) => e.kind === "lesson");
    expect(entry?.derivedFrom).toEqual([all[0]?.id]);
  });

  it("episode 保留原文 (包含未被抽成记忆的轮次也一样留存)", async () => {
    const runtime = mk();
    const session = { id: "s2" };
    runtime.onSessionStart(session);
    await turn(runtime, session, "今天天气不错"); // 无信号 → 不产生记忆
    expect(store.query({}).length).toBe(0);
    expect(episodes.all().map((e) => e.text)).toEqual(["今天天气不错"]);
  });

  it("turn 序号跨批量冲刷单调递增 (重放时顺序可复原)", async () => {
    const runtime = new HxMemoryRuntime(
      new CapturePipeline(store),
      () => ({ autoCapture: true, autoMemoryInterval: 2 }),
      { episodes, surface: "dsh" },
    );
    const session = { id: "s3" };
    runtime.onSessionStart(session);
    await turn(runtime, session, "第一轮踩坑记录");
    await turn(runtime, session, "第二轮踩坑记录");
    await turn(runtime, session, "第三轮踩坑记录");
    await runtime.flushAll();
    expect(episodes.all().map((e) => e.turn)).toEqual([1, 2, 3]);
  });

  it("episode 写失败不影响记忆落盘 (记忆层不许拖垮宿主)", async () => {
    const failing = {
      append: () => {
        throw new Error("disk full");
      },
      all: () => [],
      since: () => [],
      bySession: () => [],
      count: () => 0,
      prune: () => 0,
    };
    const errors: unknown[] = [];
    const runtime = new HxMemoryRuntime(
      new CapturePipeline(store),
      () => ({ autoCapture: true, autoMemoryInterval: 1 }),
      { episodes: failing as never, onError: (e) => errors.push(e) },
    );
    const session = { id: "s4" };
    runtime.onSessionStart(session);
    await turn(runtime, session, "踩坑: 并发要加锁");
    expect(errors.length).toBe(1);
    expect(store.query({}).some((e) => e.kind === "lesson")).toBe(true);
    expect(store.query({}).find((e) => e.kind === "lesson")?.derivedFrom).toBeUndefined();
  });
});
