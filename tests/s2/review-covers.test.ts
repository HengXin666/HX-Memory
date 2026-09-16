// tests/s2/review-covers.test.ts — 面板对 covers 的归一化 (宿主比面板旧时不能抛 TypeError)。
//
// 真实故障: 只重建 dist 不重启宿主 → 宿主返回旧契约 (covers 是计数), 面板调 .slice() 抛
// "TypeError: p.covers.slice is not a function", 用户看到的是"取不回被覆盖的条目"。
// 这是**部署状态** (宿主进程活得比面板久), 面板要把可展开性如实降级并说清原因。
import { describe, expect, it } from "vitest";
import { isStaleHostError, readCovers } from "../../src/adapters/dsh/client/review-covers.ts";

describe("covers 归一化", () => {
  it("新宿主: id 数组原样可用", () => {
    const v = readCovers(["m1", "m2"]);
    expect(v.ids).toEqual(["m1", "m2"]);
    expect(v.legacy).toBe(false);
    expect(v.count).toBe(2);
  });

  it("旧宿主: 计数标记为 legacy 且不可展开 (不是抛错)", () => {
    const v = readCovers(3);
    expect(v.legacy).toBe(true);
    expect(v.ids).toEqual([]);
    expect(v.count).toBe(3);
  });

  it("数组里的非字符串/空 id 被剔除 (宿主传来的数据同样不可信)", () => {
    const v = readCovers(["m1", "", 7, null, "m2"]);
    expect(v.ids).toEqual(["m1", "m2"]);
    expect(v.count).toBe(2);
  });

  it("坏形态退化成 0 条而不是崩溃 (null / 字符串 / 对象)", () => {
    for (const raw of [null, undefined, "m1,m2", {}, NaN, -1, []]) {
      const v = readCovers(raw);
      expect(v.legacy).toBe(false);
      expect(v.count).toBe(0);
      expect(v.ids).toEqual([]);
    }
  });
});

describe("旧宿主的判定", () => {
  it("客户端 unknown remote method 与宿主侧未实现都算旧宿主", () => {
    expect(isStaleHostError(new Error('hx-memory rpc: unknown remote method "entriesByIds"'))).toBe(
      true,
    );
    expect(isStaleHostError(new Error("hxMemory.entriesByIds: method not implemented"))).toBe(true);
    expect(isStaleHostError(new Error("hxMemory.entriesByIds: 404"))).toBe(true);
  });

  it("真正的数据错误不算旧宿主 (不能把别的问题误报成重启就好)", () => {
    expect(isStaleHostError(new Error("hxMemory.entriesByIds: database is locked"))).toBe(false);
    expect(isStaleHostError(new Error("entriesByIds: SQLITE_BUSY"))).toBe(false);
    expect(isStaleHostError(undefined)).toBe(false);
  });

  it("字符串形态的错误同样识别 (rpc 层可能直接抛字符串)", () => {
    expect(isStaleHostError("unknown remote method entriesByIds")).toBe(true);
  });
});
