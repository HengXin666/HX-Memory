// tests/s1/prompts.test.ts — S1: 提示词抽离 (非硬编码, 可配置, 可测试)。
import { describe, expect, it } from "vitest";
import {
  DEFAULT_STRUCTURER_PROMPT,
  DEFAULT_ABSTRACTOR_PROMPT,
  fillTemplate,
} from "../../src/prompts.ts";

describe("提示词抽离: 默认值非空且含输出契约", () => {
  it("结构化器提示词非空", () => {
    expect(DEFAULT_STRUCTURER_PROMPT.length).toBeGreaterThan(20);
    expect(DEFAULT_STRUCTURER_PROMPT).toContain("summary");
    expect(DEFAULT_STRUCTURER_PROMPT).toContain("tags");
  });

  it("提炼器提示词非空且含 RULE 输出契约", () => {
    expect(DEFAULT_ABSTRACTOR_PROMPT.length).toBeGreaterThan(20);
    expect(DEFAULT_ABSTRACTOR_PROMPT).toContain("RULE");
    expect(DEFAULT_ABSTRACTOR_PROMPT).toContain("CONFIDENCE");
  });
});

describe("fillTemplate: 占位符替换", () => {
  it("替换 {{name}} 为值", () => {
    expect(fillTemplate("主题: {{theme}}", { theme: "并发" })).toBe("主题: 并发");
  });
  it("缺省键保留原文", () => {
    expect(fillTemplate("{{a}} {{b}}", { a: "x" })).toBe("x {{b}}");
  });
});
