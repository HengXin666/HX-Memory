// tests/s2/parse-tags-hardening.test.ts — tag 解析不接受**强转出来的垃圾**。
//
// 为什么需要它 (2026-09-18, §508 横向排查发现): 旧实现是 `parsed.map((t) => String(t)).filter(Boolean)`。
// `String(undefined) === "undefined"` 是**非空字符串** ⇒ `.filter(Boolean)` **放行** ⇒
// 垃圾 tag 进了 `tags` 表。真库实测受害者:
//
// ```text
// [session:tool] tags=["r376080139","r406636358","undefined"]   ← 内部 id 与 "undefined"
// [session:tool] tags=["10"]                                    ← 数字被强转
// ```
//
// 而 tag **不是**无关紧要的元数据: `neighbors.ts:86` 用 tag 扩大演化裁决的候选面 ——
// "标签错了"会改变**与谁比较** (实测 `testing` 类 tag 已有 125 条, 超过候选面上限 36 而被截断)。
import { describe, expect, it } from "vitest";
import { parseTags } from "../../src/storage/markdown-parse.ts";

describe("parseTags 只接受真正的标签字符串", () => {
  it("**拒绝类型强转产生的垃圾**", () => {
    // JSON 里的 null / 数字 / 嵌套数组都必须被丢弃
    expect(parseTags("[null, 1, [\"x\"], \"good\"]")).toEqual(["good"]);
    expect(parseTags("[1, 2, 3]")).toEqual([]);
    expect(parseTags("[[\"x\"]]")).toEqual([]);
  });

  it("**拒绝哨兵字面量 null/undefined** (真库的实际形态)", () => {
    // 它们在真库里是**字符串字面量** (上游把 JS 的 null 拼进了 JSON 文本), 类型判据拦不住
    expect(parseTags('["a","undefined","b"]')).toEqual(["a", "b"]);
    expect(parseTags('["a","null","b"]')).toEqual(["a", "b"]);
    expect(parseTags('["NULL","Undefined"]')).toEqual([]);
  });

  it("**保留正常标签并去空白**", () => {
    expect(parseTags('["  spaced  ","x"]')).toEqual(["spaced", "x"]);
    expect(parseTags('["住宅代理","MITM"]')).toEqual(["住宅代理", "MITM"]);
  });

  it("**空串被丢弃** (它会让 tags 表里出现空标签)", () => {
    expect(parseTags('["", "a"]')).toEqual(["a"]);
    expect(parseTags('["   "]')).toEqual([]);
  });

  it("**旧格式 (逗号分隔) 仍兼容**", () => {
    expect(parseTags("[a, b]")).toEqual(["a", "b"]);
  });

  it("**拒绝合法字符串形态的垃圾** (类型判据拦不住的那些)", () => {
    // 实测真库 113 个 tag 里 10 个是垃圾, 其中 6 个是**数值型** ——
    // 它们是合法字符串, 所以只有**形态判据**能挡。内部 id 是规则条目 id 被误写。
    expect(parseTags(String.raw`["10","1","13","good"]`)).toEqual(["good"]);
    expect(parseTags(String.raw`["r376080139","good"]`)).toEqual(["good"]);
    // ⚠ **单字母刻意不拦** —— 真库里只有 "i" 一例, 而一条形态规则会误伤测试数据与
    // 未来可能的合法单字母标签。判据只拦有明确证据的形态 (数值型/内部id/哨兵)。
    expect(parseTags(String.raw`["i","good"]`)).toEqual(["i", "good"]);
    // ⚠ "tag"/"tags" **也刻意不拦** —— 真库各出现 1 次, 证据不足; 且拦它会引入
    // "哪些通用词算垃圾"的无穷判断。判据只留三条有**形态证据**的规则。
    expect(parseTags(String.raw`["tag","good"]`)).toEqual(["tag", "good"]);
  });

  it("**但短标签必须保留** —— 判据不能笼统按长度砍", () => {
    // ⚠ 这是本判据最容易写错的地方: 我第一版想砍长度 2~3, 而实测真库里有大量
    // **长度 2~3 的真标签** (中文双字词与英文缩写)。砍掉它们损失的是真信息。
    expect(parseTags(String.raw`["认证","换号","闸门"]`)).toEqual(["认证", "换号", "闸门"]);
    expect(parseTags(String.raw`["VPS","SSE","MITM"]`)).toEqual(["VPS", "SSE", "MITM"]);
    expect(parseTags(String.raw`["反检测"]`)).toEqual(["反检测"]);
  });
  it("undefined 输入返回 undefined (不是空数组 —— 语义不同)", () => {
    // 空数组 = "明确写了空 tags"; undefined = "没这个字段" (合并补丁时行为不同)
    expect(parseTags(undefined)).toBeUndefined();
  });
});
