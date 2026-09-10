// tests/s1/hashing.test.ts — 统一的哈希与归一化 (单一事实源的回归护栏)。
//
// 这些函数曾经在 4 个文件里各写一份 (jscpd 标出的 clone)。它们的语义必须**完全一致**:
// 内容指纹决定"要不要重嵌", token 哈希决定"落到哪个维度" —— 两处分叉会造成
// "看着没变却重嵌了"/"以为变了却没重嵌"这类静默行为差异。
import { describe, expect, it } from "vitest";
import { contentFingerprint, fnv1a32, l2Normalize } from "../../src/kernel/hashing.ts";
import { cosine } from "../../src/retrieval/embedding.ts";

describe("kernel/hashing", () => {
  it("fnv1a32 确定性且落在 32 位无符号范围", () => {
    expect(fnv1a32("容器并发")).toBe(fnv1a32("容器并发"));
    expect(fnv1a32("a")).not.toBe(fnv1a32("b"));
    for (const text of ["", "a", "容器并发策略"]) {
      const h = fnv1a32(text);
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThanOrEqual(0xffffffff);
    }
  });

  it("内容指纹含长度后缀 (不同长度的同前缀文本不会碰撞)", () => {
    expect(contentFingerprint("abc")).not.toBe(contentFingerprint("abcd"));
    expect(contentFingerprint("abc")).toBe(contentFingerprint("abc"));
  });

  it("l2Normalize: 归一化后自身余弦为 1, 零向量不产生 NaN", () => {
    const v = l2Normalize([3, 4]);
    expect(cosine(v, v)).toBeCloseTo(1, 10);
    const zero = l2Normalize([0, 0, 0]);
    expect(zero.every((x) => Number.isFinite(x))).toBe(true);
    expect(cosine(zero, zero)).toBe(0);
  });

  it("l2Normalize 是原地操作 (调用方依赖这个语义, 避免额外分配)", () => {
    const v = [3, 4];
    const out = l2Normalize(v);
    expect(out).toBe(v);
  });
});
