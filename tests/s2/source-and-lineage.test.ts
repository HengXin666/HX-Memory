// tests/s2/source-and-lineage.test.ts — 来源与血缘的端到端契约。
//
// 为什么要有这条: 产品承诺"每条记忆可溯源", 而实现层曾把来源写成常量 "session:tool"
// (实测真库 98/125 条 = 78%), 于是"这条结论来自哪次会话"不可回答。
// 本测试钉住两件事: ①主动写记忆带真实来源; ②捕获路径写出可解引用的血缘。
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemoryStack } from "../../src/app/stack.ts";
import { registerMemoryTools } from "../../src/adapters/dsh/tools.ts";
import { CapturePipeline } from "../../src/capture/pipeline.ts";
import { EpisodeStore } from "../../src/storage/episode-store.ts";
import { flushTurn } from "../../src/adapters/dsh/capture-ledger.ts";

interface ToolLike {
  name: string;
  execute: (a: Record<string, unknown>) => Promise<string>;
}

function toolsOf(stack: ReturnType<typeof openMemoryStack>, sourceOf?: () => string | undefined): ToolLike[] {
  const reg: ToolLike[] = [];
  registerMemoryTools(
    { tools: { register: (t: { name: string }) => { reg.push(t as never); return () => {}; } } },
    { store: stack.store, generalizer: null as never, ...(sourceOf ? { sourceOf } : {}) },
  );
  return reg;
}

let root = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "src-lineage-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("来源 (source) 是真实会话, 不是常量", () => {
  it("memory_save 写入真实 session id (取代常量 session:tool)", async () => {
    const stack = openMemoryStack(root, { episodeRetentionDays: 0, embedder: null });
    const save = toolsOf(stack, () => "session-REAL-1234").find((t) => t.name === "memory_save")!;
    await save.execute({ content: "真实来源验证条目内容", kind: "fact", project: "p" });
    const e = stack.store.all().find((x) => x.content.includes("真实来源验证条目内容"))!;
    expect(e.source).toBe("session:session-REAL-1234");
    stack.close();
  });

  it("取不到会话时退回旧常量 (向后兼容, 不静默丢来源)", async () => {
    const stack = openMemoryStack(root, { episodeRetentionDays: 0, embedder: null });
    const save = toolsOf(stack).find((t) => t.name === "memory_save")!;
    await save.execute({ content: "无宿主来源的回退条目", kind: "fact" });
    const e = stack.store.all().find((x) => x.content.includes("无宿主来源的回退条目"))!;
    expect(e.source).toBe("session:tool");
    stack.close();
  });

  it("不同会话写入的来源互不相同 (否则无法按会话回溯)", async () => {
    const stack = openMemoryStack(root, { episodeRetentionDays: 0, embedder: null });
    const saveA = toolsOf(stack, () => "session-A").find((t) => t.name === "memory_save")!;
    await saveA.execute({ content: "会话 A 的条目内容", kind: "fact" });
    const saveB = toolsOf(stack, () => "session-B").find((t) => t.name === "memory_save")!;
    await saveB.execute({ content: "会话 B 的条目内容", kind: "fact" });
    const all = stack.store.all();
    const a = all.find((x) => x.content.includes("会话 A 的"))!;
    const b = all.find((x) => x.content.includes("会话 B 的"))!;
    expect(a.source).not.toBe(b.source);
    stack.close();
  });
});

describe("血缘 (derivedFrom) 可解引用到原话", () => {
  it("捕获路径写出 derivedFrom, 且能追到 episode 原文", async () => {
    const stack = openMemoryStack(root, { episodeRetentionDays: 0, embedder: null });
    const episodes = new EpisodeStore({ root, retentionDays: 0 });
    const pipe = new CapturePipeline(stack.store);
    await flushTurn(
      { episodes: () => episodes, log: () => null, pipe, surface: "dsh" },
      {
        session: "session-cap-1",
        turn: 1,
        project: "p",
        question: "记住: 血缘引用必须能被解引用回原始对话原文",
        answer: "已记录: 血缘引用必须能被解引用回原始对话原文。",
      } as never,
    );
    const withDf = stack.store.all().filter((e) => (e.derivedFrom ?? []).length > 0);
    expect(withDf.length).toBeGreaterThan(0);

    // 解引用: derivedFrom 的 id 必须能在 episode 日志里找到原文
    const epDir = join(root, "episodes");
    const rows: Array<{ id: string; text: string }> = [];
    for (const f of readdirSync(epDir)) {
      for (const line of readFileSync(join(epDir, f), "utf8").split("\n")) {
        if (line.trim()) rows.push(JSON.parse(line));
      }
    }
    const ids = withDf[0]!.derivedFrom!;
    const found = rows.filter((r) => ids.includes(r.id));
    expect(found.length).toBe(ids.length);
    expect(found.some((r) => r.text.includes("血缘引用必须能被解引用"))).toBe(true);
    stack.close();
  });

  it("捕获路径的来源也是真实会话 id", async () => {
    const stack = openMemoryStack(root, { episodeRetentionDays: 0, embedder: null });
    const episodes = new EpisodeStore({ root, retentionDays: 0 });
    const pipe = new CapturePipeline(stack.store);
    await flushTurn(
      { episodes: () => episodes, log: () => null, pipe, surface: "dsh" },
      {
        session: "session-cap-2",
        turn: 2,
        project: "p",
        question: "记住: 捕获路径的来源必须写明是哪个会话产生的这条记忆",
        answer: "已记录该约束。",
      } as never,
    );
    const e = stack.store.all().find((x) => x.content.includes("捕获路径的来源"))!;
    expect(e.source).toBe("session:session-cap-2");
    stack.close();
  });
});
