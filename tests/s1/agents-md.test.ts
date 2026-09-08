// tests/s1/agents-md.test.ts — S1: AGENTS.md 渲染/更新纯逻辑。
import { describe, expect, it } from "vitest";
import { renderRulesMd, updateAgentsMd, START, END } from "../../src/adapters/codex/agents-md.ts";
import type { MemoryEntry } from "../../src/kernel/types.ts";

const rule: MemoryEntry = {
  id: "r1",
  kind: "rule",
  content: "所有容器都要显式设计并发上限",
  source: "generalizer:x",
  scope: "global",
  ts: { validAt: "2026-01-01T00:00:00.000Z", assertedAt: "2026-01-01T00:00:00.000Z" },
  confirmedBy: "u",
  confirmedAt: "t",
};

describe("renderRulesMd", () => {
  it("wraps rules in markers with zh header", () => {
    const md = renderRulesMd({ existing: "", rules: [rule], language: "zh" });
    expect(md.startsWith(START)).toBe(true);
    expect(md.endsWith(END)).toBe(true);
    expect(md).toContain("所有容器都要显式设计并发上限");
    expect(md).toContain("跨项目规则");
  });

  it("empty rules renders placeholder", () => {
    const md = renderRulesMd({ existing: "", rules: [], language: "zh" });
    expect(md).toContain("暂无已确认规则");
  });
});

describe("updateAgentsMd", () => {
  it("appends section when AGENTS.md has none", () => {
    const out = updateAgentsMd({
      existing: "# 项目说明\n\n这是已有内容",
      rules: [rule],
      language: "zh",
    });
    expect(out).toContain("# 项目说明");
    expect(out).toContain("所有容器都要显式设计并发上限");
  });

  it("replaces existing section in place (idempotent content)", () => {
    const first = updateAgentsMd({ existing: "", rules: [rule], language: "zh" });
    const second = updateAgentsMd({ existing: first, rules: [rule], language: "zh" });
    expect(second).toBe(first); // 幂等
    expect(second.match(new RegExp(START, "g"))?.length).toBe(1);
  });

  it("preserves user content outside the section", () => {
    const existing = "用户手写内容\n" + START + "旧规则" + END + "\n尾部";
    const out = updateAgentsMd({ existing, rules: [rule], language: "zh" });
    expect(out).toContain("用户手写内容");
    expect(out).toContain("尾部");
    expect(out).not.toContain("旧规则");
  });
});
