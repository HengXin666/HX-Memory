// tests/s1/function-words.test.ts — 查询侧虚词判据的边界。
//
// 为什么值得单独一组断言: 这个判据直接决定**弃权会不会发生** —— 它错了, 检索就会给任何
// 查询返回一堆"高覆盖"噪声 (实测: 无关查询在 HX-Sagasu 工作日志上得到 cov=0.63)。
// 而它同时被写入期的近邻查找复用, 收得太紧会让语义去重静默失效 (coverageMode: "candidate")。
// 因此这里钉住三件事: ①虚词与单字碎片被剔除; ②内容词一个都不能误伤; ③过滤后为空时退回原表。
import { describe, expect, it } from "vitest";
import { discriminativeTerms, isFunctionWord } from "../../src/kernel/function-words.ts";
import { queryTerms } from "../../src/retrieval/channels.ts";

describe("虚词判据", () => {
  it("虚词与单字碎片不参与覆盖率", () => {
    for (const w of ["的", "用", "写", "一个", "什么", "怎么", "为什么", "如何", "我的", "看看"]) {
      expect(isFunctionWord(w), w).toBe(true);
    }
    // 单字碎片: 服务→器, 依赖数组→组
    for (const w of ["器", "组", "数", "卡", "网"]) {
      expect(isFunctionWord(w), w).toBe(true);
    }
  });

  it("内容词一个都不误伤 (误伤的代价是漏召回)", () => {
    for (const w of ["服务", "提交", "依赖", "架构", "滚动", "回归", "校验", "修复", "rust", "clash", "verge", "websocket", "ppt", "io", "2fa"]) {
      expect(isFunctionWord(w), w).toBe(false);
    }
  });

  it("单字判据只覆盖 CJK —— 拉丁短标识符一律保留", () => {
    // 为什么不做"长度 < 2 一律剔除": "a" / "x" 这类单字母在英文查询里偶有实义,
    // 而单字碎片问题**只发生在 CJK** (中文没有空格分词, 切出来的单字几乎总是碎片)。
    // 收紧到只认 CJK, 收益不变而误伤面为零。
    expect(isFunctionWord("io")).toBe(false);
    expect(isFunctionWord("ai")).toBe(false);
    expect(isFunctionWord("a")).toBe(false);
    expect(isFunctionWord("器")).toBe(true);
  });

  it("discriminativeTerms 保持原顺序 (排序依赖它)", () => {
    expect(discriminativeTerms(["的", "rust", "用", "websocket", "服务"])).toEqual([
      "rust",
      "websocket",
      "服务",
    ]);
  });
});

describe("queryTerms 的覆盖率词表", () => {
  it("读路径 (默认) 剔除虚词与单字碎片", () => {
    const t = queryTerms("如何用 Rust 写一个 WebSocket 服务器");
    expect(t.weighted).toEqual(["rust", "websocket", "服务"]);
  });

  it("候选生成路径 (keepFunctionWords) 保留全词表", () => {
    const t = queryTerms("每次部署前要跑一遍全量回归校验", { keepFunctionWords: true });
    expect(t.weighted).toContain("前");
    expect(t.weighted).toContain("要");
    expect(t.weighted).toContain("回归");
  });

  it("过滤后为空时退回原词表 (单字查询不能因此失效)", () => {
    expect(queryTerms("卡").weighted).toEqual(["卡"]);
  });

  it("terms (bigram 流) 不受影响 —— 语音容错仍要求原形与归一形都在", () => {
    const t = queryTerms("密等问题怎么处理");
    expect(t.terms).toContain("密等");
    expect(t.terms).toContain("幂等");
  });
});
