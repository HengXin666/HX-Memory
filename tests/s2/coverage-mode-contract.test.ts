// tests/s2/coverage-mode-contract.test.ts — `coverageMode` 是一个**开关三件事**的参数。
//
// 为什么需要它 (2026-09-18, §741 实测: 全库唯一测试只**提了它一句注释**, 没有行为断言):
//
// ```ts
// // hybrid.ts:188  分词是否剔虚词
// const terms = queryTerms(text, { keepFunctionWords: req.coverageMode === "candidate" });
// // hybrid.ts:193  资格门槛用哪份词表
// const gateTerms = req.coverageMode === "candidate" ? terms : queryTerms(text, { keepFunctionWords: true });
// // hybrid.ts:357  **是否走弃权闸门**
// if (req.coverageMode !== "candidate" && … && shouldAbstain(…)) { result.hits = []; }
// ```
//
// 而**唯一的调用方**是 `app/neighbors.ts:77` (写入期近邻查找) —— 那意味着
// "近邻查找**永不弃权**"。那是有意的 (候选生成要召回, 不是回答), 但它**没有任何断言**。
//
// 实测分叉: 拿一个"字面沾一个词但整体不相关"的查询 ——
// | 模式 | 结果 |
// | --- | --- |
// | `precision` (默认) | **弃权** (hits 清空) |
// | `candidate` | **保留** |
//
// ⇒ 本测试守住那条分叉: 两模式**必须在弃权上给出不同答案**, 否则那个参数就是死的。
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileBackend } from "../../src/storage/file-store.ts";
import { HybridRetriever } from "../../src/retrieval/hybrid.ts";
import type { MemoryEntry } from "../../src/kernel/types.ts";

const T = { validAt: "2026-01-01T00:00:00Z", assertedAt: "2026-01-01T00:00:00Z" };
/** 只沾一个词 ("回归测试"), 其余全是别的技术栈 —— 覆盖率必然低于门槛。 */
const BODY = "回归测试可以在上线前发现大部分问题";
const QUERY = "如何给 Kubernetes 集群做回归测试并自动扩容节点";

function setup(): { store: FileBackend; r: HybridRetriever; root: string } {
  const root = mkdtempSync(join(tmpdir(), "covmode-"));
  const store = new FileBackend({ root });
  store.add({ id: "f1", kind: "fact", content: BODY, source: "t", scope: "agent", ts: T } as MemoryEntry);
  return { store, r: new HybridRetriever(store, { now: () => T.validAt }), root };
}

/** 是否被弃权闸门清空 (degraded 里带 coverage/abstain 之类的原因)。 */
function abstained(out: { hits: unknown[]; degraded?: readonly string[] }): boolean {
  return out.hits.length === 0 && (out.degraded ?? []).some((d) => /coverage|abstain/i.test(d));
}

describe("coverageMode: 一个开关三件事", () => {
  it("**precision (默认) 会弃权** —— 低覆盖率查询必须返回空", () => {
    const { store, r, root } = setup();
    try {
      const out = r.retrieveSync({ text: QUERY, limit: 10, purpose: "recall" } as never);
      expect(abstained(out), "precision 下这条低覆盖率查询应被弃权: hits=" + out.hits.length).toBe(true);
    } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it("**candidate 不弃权** —— 候选生成要的是召回, 不是回答", () => {
    const { store, r, root } = setup();
    try {
      const out = r.retrieveSync({ text: QUERY, limit: 10, purpose: "recall", coverageMode: "candidate" } as never);
      expect(abstained(out), "candidate 下不该被弃权 (近邻查找靠它)").toBe(false);
    } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it("### 两模式的**答案必须不同** (否则那个参数是死的)", () => {
    const { store, r, root } = setup();
    try {
      const prec = r.retrieveSync({ text: QUERY, limit: 10, purpose: "recall" } as never);
      const cand = r.retrieveSync({ text: QUERY, limit: 10, purpose: "recall", coverageMode: "candidate" } as never);
      expect(
        prec.hits.length === cand.hits.length && abstained(prec) === abstained(cand),
        "coverageMode 在弃权上必须给出不同答案 (precision=" + prec.hits.length + ", candidate=" + cand.hits.length + ")",
      ).toBe(false);
    } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it("### 负例: **高覆盖率查询下两模式都不弃权** (参数不是「总是分叉」)", () => {
    const { store, r, root } = setup();
    try {
      // 直接问那条记忆本身 ⇒ 覆盖率足够, 两种模式都该保留。
      const prec = r.retrieveSync({ text: BODY, limit: 10, purpose: "recall" } as never);
      const cand = r.retrieveSync({ text: BODY, limit: 10, purpose: "recall", coverageMode: "candidate" } as never);
      expect(abstained(prec)).toBe(false);
      expect(abstained(cand)).toBe(false);
      expect(prec.hits.length).toBeGreaterThan(0);
    } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
  });
});
