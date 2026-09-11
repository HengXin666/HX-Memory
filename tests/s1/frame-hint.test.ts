// tests/s1/frame-hint.test.ts — 注入块末尾的"可操作入口" (s1)。
//
// 为什么值得钉: 实测 memory_search 在本项目的调用率是 0/7440 —— 指引里"建议主动查"完全没生效。
// 注入块是模型唯一一定会读到、且与记忆直接相关的位置, 因此把"还能继续查"做成每轮可见的**选项**。
// 两个必须成立的性质:
//   1. 入口句必须**可选** (给选项, 不是给义务) —— 否则会把可选项变成模型必须完成的步骤;
//   2. 入口句**不得干扰条目 id 解析** —— 否则差量注入的去重会失效 (那正是刚修好的 bug)。
import { describe, expect, it } from "vitest";
import { memoryEntryHint, memoryFrameNote } from "../../src/kernel/format-frame.ts";
import { formatEntryLine, parseInjectedIds } from "../../src/kernel/injection-format.ts";

describe("memoryEntryHint: 给选项, 不给义务", () => {
  it("中英都有, 且明确标为可选", () => {
    expect(memoryEntryHint("zh")).toContain("memory_search");
    expect(memoryEntryHint("en")).toContain("memory_search");
    expect(memoryEntryHint("zh")).toContain("可选");
    expect(memoryEntryHint("en").toLowerCase()).toContain("optional");
  });

  it("语气是'不适用就忽略', 不是'请评价/请确认'", () => {
    const zh = memoryEntryHint("zh");
    expect(zh).toContain("忽略");
    expect(zh).not.toContain("必须");
    expect(zh).not.toContain("评价");
  });

  it("默认语言是 zh (与框架句一致)", () => {
    expect(memoryEntryHint()).toBe(memoryEntryHint("zh"));
  });
});

describe("入口句不干扰条目 id 解析", () => {
  it("含入口句的注入块仍能解析出全部条目 id", () => {
    const block = [
      memoryFrameNote("zh"),
      formatEntryLine("rule-1", "规则一"),
      formatEntryLine("lesson-2", "教训二"),
      memoryEntryHint("zh"),
    ].join("\n");
    expect(parseInjectedIds(block)).toEqual(["rule-1", "lesson-2"]);
  });

  it("入口句本身不含 id 标记 (不能凭空造出一个已注入 id)", () => {
    expect(parseInjectedIds(memoryEntryHint("zh"))).toEqual([]);
    expect(parseInjectedIds(memoryEntryHint("en"))).toEqual([]);
  });
});
