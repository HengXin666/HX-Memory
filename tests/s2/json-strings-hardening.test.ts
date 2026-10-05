// tests/s2/json-strings-hardening.test.ts — id 数组解析**不做强转** (与 parseTags 同一口径)。
//
// 为什么需要它 (2026-09-18, §538 横向排查): 这是一个**同型缺陷的三处副本** ——
// `parsed.map((v) => String(v)).filter(Boolean)` 出现在:
//   · `parseTags` (已修, §511) —— 服务 tags;
//   · `jsonStrings` (entry-normalize.ts) —— 服务索引列的 entities/derived_from/merged_from;
//   · `parseStringArray` (markdown-parse.ts) —— 服务真相文件的同三个字段。
//
// `String(null) === "null"` 与 `String(1) === "1"` 都是**非空字符串** ⇒ `filter(Boolean)` 放行。
// 而 `"null"`/`"undefined"`/`"1"` **既不是实体键也不是记忆 id** —— 一旦进索引就会参与
// `byEntities` 反查 (而 `neighbors.ts` 用它**扩大演化裁决的候选面**)。
//
// 实测真库这三个字段目前**干净** ⇒ 所以这是**加固**, 不是修既有数据。本文件那个"真库干净"
// 的事实也因此重要: 它说明**没人踩过**, 而不是**踩了没事**。
import { describe, expect, it } from "vitest";
import { jsonStrings } from "../../src/storage/entry-normalize.ts";

describe("jsonStrings: id 数组只能含真字符串", () => {
  it("**拒绝强转产物** (null 与数字)", () => {
    expect(jsonStrings('[null, "a"]')).toEqual(["a"]);
    expect(jsonStrings("[1, 2]")).toEqual(undefined);
    expect(jsonStrings('[["x"], "ok"]')).toEqual(["ok"]);
  });

  it("**拒绝哨兵字面量** (它们在真库里的形态是字符串)", () => {
    expect(jsonStrings('["undefined","mem-1"]')).toEqual(["mem-1"]);
    expect(jsonStrings('["null","mem-1"]')).toEqual(["mem-1"]);
    expect(jsonStrings('["NULL","Undefined","mem-1"]')).toEqual(["mem-1"]);
  });

  it("**保留真实体与 id, 并去空白**", () => {
    expect(jsonStrings('["hx-memory","  m1 ","认证"]')).toEqual(["hx-memory", "m1", "认证"]);
  });

  it("空数组 / 全坏值 就返回 undefined (与字段缺失语义一致)", () => {
    expect(jsonStrings("[]")).toBeUndefined();
    expect(jsonStrings("[null]")).toBeUndefined();
    expect(jsonStrings("")).toBeUndefined();
    expect(jsonStrings(null)).toBeUndefined();
  });

  it("坏 JSON 不抛 (索引是派生物, 损坏不该影响其它字段)", () => {
    expect(jsonStrings("{不是数组")).toBeUndefined();
  });
});
