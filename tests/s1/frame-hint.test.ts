// tests/s1/frame-hint.test.ts — 注入块的框架句与首轮可用声明。
//
// ## 2026-09-29 改口径: 从"每轮入口提示"到"首轮一行声明"
//
// 旧版有两样东西: 3 句框架免责 (98 token) + 每轮都发的末尾入口提示 (39 token)。
// 实测它们说的话**几乎全部已在 `memory_search` 工具描述里逐字存在**, 而工具描述是常驻
// 且必需的 ⇒ 注入块里那份是纯重复 (用户原话"太多无用上下文")。
//
// 现在: 框架句压成一句 (只留工具描述覆盖不到的两条语义), 入口提示变**首轮一次的可用声明**。
// 本文件守两件事:
//   1. **保留的语义不得再被删** —— 它是"这不是新指令"与"rule 是已确认约束"的唯一载体;
//   2. **入口/框架不得干扰 id 解析** —— 旧的机器标记仍必须能被 `parseInjectedIds` 解析
//      (历史会话日志里大量存在), 而新注入的 id 走消息 source。
import { describe, expect, it } from "vitest";
import { memoryEntryHint, memoryFrameNote, composeMemoryBlock, MEMORY_BLOCK_HEADING } from "../../src/kernel/format-frame.ts";
import { formatEntryLine, parseInjectedIds, entryIdsOfSource } from "../../src/kernel/injection-format.ts";

describe("框架句: 只留工具描述覆盖不到的两条语义", () => {
  it("必须声明'不是新指令' (注入以 user 角色进入, 不声明会被误读成用户命令)", () => {
    expect(memoryFrameNote("zh")).toMatch(/不是新指令|不是指令/);
    expect(memoryFrameNote("en").toLowerCase()).toMatch(/not new instructions|not instructions/);
  });

  it("必须声明 rule 的效力等级 (工具描述不说 kind 语义)", () => {
    expect(memoryFrameNote("zh")).toContain("rule");
    expect(memoryFrameNote("en").toLowerCase()).toContain("rule");
  });

  it("压到一句: 不再回退成多句免责声明", () => {
    // 旧版是三句 join。新版必须是一句 —— 这条挡住"以后又堆回去"的退化。
    for (const lang of ["zh", "en"] as const) {
      const t = memoryFrameNote(lang);
      expect(t.length, lang + " 框架句过长").toBeLessThan(70);
      expect(t.endsWith("。") || t.endsWith("."), lang + " 框架句应以句号收尾 (单句)").toBe(true);
    }
  });

  it("默认语言是 zh (与注入块其余部分一致)", () => {
    expect(memoryFrameNote()).toBe(memoryFrameNote("zh"));
    expect(memoryEntryHint()).toBe(memoryEntryHint("zh"));
  });
});

describe("首轮可用声明", () => {
  it("点出工具名与可查的对象", () => {
    expect(memoryEntryHint("zh")).toContain("memory_search");
    expect(memoryEntryHint("en")).toContain("memory_search");
  });

  it("不得含 id 标记 (它不能凭空造出一个'已注入' id)", () => {
    expect(parseInjectedIds(memoryEntryHint("zh"))).toEqual([]);
    expect(parseInjectedIds(memoryEntryHint("en"))).toEqual([]);
  });
});

describe("composeMemoryBlock: 空正文时不写框架句", () => {
  it("有正文 → 标题 + 框架 + 正文", () => {
    const block = composeMemoryBlock({ body: "- [rule] 内容", language: "zh" });
    expect(block.startsWith(MEMORY_BLOCK_HEADING)).toBe(true);
    expect(block).toContain(memoryFrameNote("zh"));
    expect(block).toContain("- [rule] 内容");
  });

  it("只有指引、没有正文 → 标题 + 指引 (空块上谈'这是历史记忆'没有指代对象)", () => {
    const block = composeMemoryBlock({ guidance: memoryEntryHint("zh"), language: "zh" });
    expect(block).toContain(memoryEntryHint("zh"));
    expect(block).not.toContain(memoryFrameNote("zh"));
  });

  it("不再有末尾入口句 (它已变成首轮声明的形态)", () => {
    // 旧形态会把入口提示固定追加在块尾; 新形态里它只是 guidance 参数的一种取值,
    // 没有 guidance 时块尾就是最后一条正文 —— 这条断言挡住"悄悄加回固定尾句"。
    const block = composeMemoryBlock({ body: "- [rule] 最后一条", language: "zh" });
    expect(block.trimEnd().endsWith("- [rule] 最后一条")).toBe(true);
  });
});

describe("id 解析: 两条来源都要认", () => {
  it("历史形态: 正文行尾标记仍能解析 (旧会话日志里大量存在)", () => {
    const legacy = [
      memoryFrameNote("zh"),
      "- [rule] 规则一 <!--hx-memory:id=rule-1-->",
      "- [lesson] 教训二 <!--hx-memory:id=lesson-2-->",
      memoryEntryHint("zh"),
    ].join("\n");
    expect(parseInjectedIds(legacy)).toEqual(["rule-1", "lesson-2"]);
  });

  it("新形态: 正文里没有 id, id 从消息 source 取", () => {
    const line = formatEntryLine("rule-1", "规则一", "rule");
    expect(line).toBe("- [rule] 规则一");
    expect(parseInjectedIds(line), "新正文不该含任何标记").toEqual([]);
    expect(entryIdsOfSource({ kind: "plugin:hx-memory", form: "instructions", entryIds: ["rule-1"] })).toEqual(["rule-1"]);
  });

  it("entryIdsOfSource 对畸形输入只回空数组, 不臆造", () => {
    expect(entryIdsOfSource(undefined)).toEqual([]);
    expect(entryIdsOfSource({})).toEqual([]);
    expect(entryIdsOfSource({ entryIds: "rule-1" })).toEqual([]);
    expect(entryIdsOfSource({ entryIds: [1, "ok", null] })).toEqual(["ok"]);
  });
});
