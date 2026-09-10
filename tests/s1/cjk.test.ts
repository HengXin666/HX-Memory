// tests/s1/cjk.test.ts — 分词契约 (索引与查询必须对称; 中文 2 字查询必须可召回)。
import { describe, expect, it } from "vitest";
import {
  TOKENIZER_VERSION,
  indexTermColumns,
  matchExpression,
  searchableText,
  termStreams,
} from "../../src/kernel/cjk.ts";
import type { MemoryEntry } from "../../src/kernel/types.ts";

describe("kernel/cjk", () => {
  it("索引格式带版本号 (分词逻辑变化必须能触发重建)", () => {
    expect(TOKENIZER_VERSION).toBeGreaterThanOrEqual(1);
  });

  it("中文: 词流与 bigram 流都产出, bigram 保证 2 字查询可命中", () => {
    const s = termStreams("所有容器实际上都有并发策略问题");
    expect(s.words).toContain("容器");
    expect(s.words).toContain("并发");
    // "并发" 必须作为 bigram 出现 (即便 Segmenter 把它切开也能召回)
    expect(s.bigrams).toContain("并发");
    expect(s.bigrams).toContain("容器");
  });

  it("未登录词 (Segmenter 会切碎的词) 仍可由 bigram 召回", () => {
    const s = termStreams("数据库连接池超时设置");
    expect(s.bigrams).toContain("连接");
    expect(s.bigrams).toContain("接池");
    expect(s.bigrams).toContain("池超");
    const q = matchExpression("连接池");
    expect(q).toContain('"连接"');
    expect(q).toContain('"接池"');
  });

  it("英文与数字按词切分, 小写归一", () => {
    const s = termStreams("Prefer PNPM over npm-9 in Monorepos");
    expect(s.words).toContain("prefer");
    expect(s.words).toContain("pnpm");
    expect(s.bigrams).toEqual([]);
  });

  it("MATCH 表达式: OR 语义 + 列过滤 + 引号相位不被外部文本破坏", () => {
    const expr = matchExpression('并发 "引号" AND* (x)');
    expect(expr.startsWith("{words bigrams} : (")).toBe(true);
    expect(expr.endsWith(")")).toBe(true);
    // 真实不变量: 引号必须成对 (文本里的引号不是词字符, 会被丢掉, 所以不可能闭合相位)。
    expect((expr.match(/"/g) ?? []).length % 2).toBe(0);
  });

  it("空文本/纯标点: 返回空表达式 (调用方必须短路, 否则 FTS5 语法错)", () => {
    expect(matchExpression("")).toBe("");
    expect(matchExpression("   ")).toBe("");
    expect(matchExpression("!!! ??? ...")).toBe("");
  });

  it("索引两列: words 与 bigrams 非空且可写入 FTS5", () => {
    const cols = indexTermColumns("容器并发策略");
    expect(cols.words.length).toBeGreaterThan(0);
    expect(cols.bigrams.length).toBeGreaterThan(0);
  });

  it("searchableText 覆盖 正文/摘要/要点/标签 (检索面 = 用户看到的面)", () => {
    const entry: MemoryEntry = {
      id: "c1",
      kind: "lesson",
      content: "正文关键内容",
      source: "test",
      scope: "agent",
      ts: { validAt: "2026-01-01T00:00:00.000Z", assertedAt: "2026-01-01T00:00:00.000Z" },
      tags: ["concurrency"],
      structured: { summary: "摘要文本", points: ["要点一"] },
    };
    const text = searchableText(entry);
    for (const needle of ["正文关键内容", "摘要文本", "要点一", "concurrency"]) {
      expect(text).toContain(needle);
    }
  });
});
