// tests/s2/conclusion-pipeline.test.ts — S2: 结构化器读不出结论 → 不落盘。
//
// 这是"疑问句开头的轮次"的第二道闸门: captureTurn 已经放行了带回答的问句
// (因为结论必须从回答里读), 但"讨论了半天没定论"仍然不该变成记忆。
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileBackend } from "../../src/storage/file-store.ts";
import { CapturePipeline } from "../../src/capture/pipeline.ts";
import type { TurnStructurer } from "../../src/capture/structurer.ts";

let root: string;
let store: FileBackend;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hxmem-conclusion-"));
  store = new FileBackend({ root });
});
afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

/** 结构化器 stub: 结论可控, 并且记录它到底收到了什么。 */
function stubStructurer(conclusion: string | undefined, seen: Array<{ text: string; answer?: string }>): TurnStructurer {
  return {
    async structure(input) {
      seen.push({ text: input.text, ...(input.answer ? { answer: input.answer } : {}) });
      return {
        summary: "摘要",
        tags: ["t"],
        points: ["p"],
        ...(conclusion ? { conclusion } : {}),
      };
    },
  };
}

describe("pipeline: 结论闸门与 content 替换", () => {
  it("问句 + 回答, 结构化器读出结论 → content 是结论, 不是提问", async () => {
    const seen: Array<{ text: string; answer?: string }> = [];
    const pipe = new CapturePipeline(store, {
      structurer: stubStructurer("默认改成 60 秒, 并在重启前释放会话", seen),
    });
    const r = await pipe.run({
      session: "s1",
      text: "默认多少秒? 还有重启前要不要释放会话?",
      answer: "改成 60 秒; 重启前必须先把运行中的会话释放掉。",
    });
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]!.content).toBe("默认改成 60 秒, 并在重启前释放会话");
    // 关键: 结构化器必须能看到助手的回答 (否则它只能看着问题猜)
    expect(seen[0]!.answer).toContain("重启前必须先把运行中的会话释放掉");
  });

  it("问句 + 回答, 但结构化器读不出结论 → 不落盘", async () => {
    const pipe = new CapturePipeline(store, { structurer: stubStructurer(undefined, []) });
    const r = await pipe.run({
      session: "s1",
      text: "这个是不是有问题?",
      answer: "还需要再看看。",
    });
    expect(r.entries).toHaveLength(0);
    expect(store.query({})).toHaveLength(0);
  });

  it("陈述句即使没有 conclusion 也照常落盘 (行为与旧版一致)", async () => {
    const pipe = new CapturePipeline(store, { structurer: stubStructurer(undefined, []) });
    const r = await pipe.run({ session: "s1", text: "踩坑: 并发要显式设上限" });
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]!.content).toBe("踩坑: 并发要显式设上限");
  });

  it("启发式兜底不产 conclusion → content 保持原文 (不丢信息)", async () => {
    const pipe = new CapturePipeline(store); // 默认 heuristicStructurer
    const r = await pipe.run({ session: "s1", text: "踩坑: 缓存要设过期时间" });
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]!.content).toBe("踩坑: 缓存要设过期时间");
    expect(r.entries[0]!.structured?.conclusion).toBeUndefined();
  });

  it("结构化器抛错 → 原样落盘, 不丢", async () => {
    const pipe = new CapturePipeline(store, {
      structurer: {
        async structure() {
          throw new Error("LLM down");
        },
      },
    });
    const r = await pipe.run({ session: "s1", text: "踩坑: 失败也要落盘" });
    expect(r.entries).toHaveLength(1);
  });
});
