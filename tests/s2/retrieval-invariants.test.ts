// tests/s2/retrieval-invariants.test.ts — 检索的两个基础不变量: 确定性 与 重建等价性。
//
// 为什么需要它 (2026-09-18): 这两条是 truth-in-files 架构的**前提**, 而此前没有测试直接钉住它们:
//   · **确定性**: 同一查询连跑多次必须逐位相同 —— 否则快照、基准、A/B 对照全部不可信;
//   · **重建等价**: T1 重建 (真相 → 索引) 后检索结果必须**逐位相同** ——
//     否则说明索引里有真相之外的信息, ADR-002 的"索引可重建"承诺就不成立。
//
// 实测结论 (真实库 194 条): 两条**都成立** (0/40 与 0/50 不一致)。
// 本文件用**合成语料**把它们钉成回归防线 (不依赖真实库, CI 可跑)。
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemoryStack } from "../../src/app/stack.ts";

let root = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "inv-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const SAMPLES = [
  "踩坑: prestep.ts 的注入时机由 injectMode 控制",
  "决定: 缓存过期统一设为 60 秒",
  "踩坑: gateway.ts 的形参名是协议面",
  "决定: 生产库禁止直连, 必须走只读副本",
  "踩坑: FTS 词流长度会影响 bm25 的背景分",
];

async function seed() {
  const stack = openMemoryStack(root, { episodeRetentionDays: 0 });
  for (const [i, s] of SAMPLES.entries()) {
    void i;
    await stack.facade.remember({ content: s, source: "test:seed" } as never);
  }
  return stack;
}

/** 采集一批查询的检索签名 (含分数, 因此比只比 id 更严)。 */
function signatures(stack: ReturnType<typeof openMemoryStack>) {
  return SAMPLES.map((q) =>
    stack.retriever
      .retrieveSync({ text: q, limit: 10, tokenBudget: 4000, purpose: "recall" })
      .hits.map((h) => h.entry.id + ":" + h.score.toFixed(6))
      .join("|"),
  );
}

describe("检索不变量", () => {
  it("**确定性**: 同一查询连跑 3 次逐位相同", async () => {
    const stack = await seed();
    try {
      const a = signatures(stack), b = signatures(stack), c = signatures(stack);
      expect(b).toEqual(a);
      expect(c).toEqual(a);
      // 且确实有命中 (避免"全空所以相同"的假通过)
      expect(a.some((s) => s.length > 0)).toBe(true);
    } finally {
      stack.close();
    }
  });

  it("**重建等价**: T1 重建后检索结果逐位相同", async () => {
    const stack = await seed();
    const before = signatures(stack);
    const report = await stack.rebuild.rebuildIndex();
    expect(report.errors).toEqual([]);
    const after = signatures(stack);
    expect(after).toEqual(before);
    stack.close();
  });

  it("重开栈 (跨进程) 后结果也相同", async () => {
    const s1 = await seed();
    const a = signatures(s1);
    s1.close();
    const s2 = openMemoryStack(root, { episodeRetentionDays: 0 });
    try {
      expect(signatures(s2)).toEqual(a);
    } finally {
      s2.close();
    }
  });
});
