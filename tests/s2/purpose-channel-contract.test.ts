// tests/s2/purpose-channel-contract.test.ts — `purpose` 对 **rules 通道**的那条契约。
//
// 为什么需要它 (2026-09-18, §737 实测): `hybrid.ts:196` 只有一处读 `purpose`:
//
// ```ts
// // recall = 显式搜索/面板浏览/意图召回: 规则保底通道默认关闭 (要的是"最相关")。
// // 显式传 channels.rules.enabled 仍可覆盖 —— 目的是改默认, 不是禁掉该通道。
// const recall = req.purpose === "recall";
// const enabled = (c) => req.channels?.[c]?.enabled ?? (recall && c === "rules" ? false : true);
// ```
//
// 而**既有测试只是"用 `purpose: "recall"` 去调"**, 没有一条断言这条契约本身 ——
// 于是"把 `recall` 判据写反"或"去掉可覆盖性"都不会被发现。
//
// 三档行为 (实测):
// | 调用 | rules 通道 |
// | --- | --- |
// | `purpose: "inject"` | **开** (保底不变量必须无条件在场) |
// | `purpose: "recall"` | **默认关** (要的是"最相关") |
// | `purpose: "recall"` + 显式 `rules.enabled: true` | **开** (目的是改默认, 不是禁掉) |
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileBackend } from "../../src/storage/file-store.ts";
import { HybridRetriever } from "../../src/retrieval/hybrid.ts";
import type { MemoryEntry } from "../../src/kernel/types.ts";

const T = { validAt: "2026-01-01T00:00:00Z", assertedAt: "2026-01-01T00:00:00Z" };
const RULE = "部署前必须跑全量回归";

function newRetriever(): { store: FileBackend; r: HybridRetriever; root: string } {
  const root = mkdtempSync(join(tmpdir(), "purpose-"));
  const store = new FileBackend({ root });
  store.add({
    id: "r1", kind: "rule", content: RULE, source: "t", scope: "global", ts: T,
    confirmedBy: "user", confirmedAt: T.assertedAt,
  } as MemoryEntry);
  return { store, r: new HybridRetriever(store, { now: () => T.validAt }), root };
}

/** 命中条里出现过哪些通道。 */
function channels(r: HybridRetriever, req: Record<string, unknown>): Set<string> {
  const out = r.retrieveSync({ text: RULE, limit: 10, ...req } as never);
  const s = new Set<string>();
  for (const h of out.hits) for (const c of h.channels ?? []) s.add(c);
  return s;
}

describe("purpose ↔ rules 通道的契约", () => {
  it("**inject: rules 通道开** (保底不变量无条件在场)", () => {
    const { store, r, root } = newRetriever();
    try {
      expect(channels(r, { purpose: "inject" }).has("rules")).toBe(true);
    } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it("**recall: rules 通道默认关** (要的是最相关, 不是保底)", () => {
    const { store, r, root } = newRetriever();
    try {
      expect(channels(r, { purpose: "recall" }).has("rules")).toBe(false);
    } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it("**recall + 显式 rules.enabled: true ⇒ 仍然开** (目的是改默认, 不是禁掉)", () => {
    const { store, r, root } = newRetriever();
    try {
      expect(channels(r, { purpose: "recall", channels: { rules: { enabled: true } } }).has("rules")).toBe(true);
    } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it("### 负例: 那条规则**不靠** rules 通道时也能被别的原因召回 (证明确实是通道开关, 不是'整条查不到')", () => {
    const { store, r, root } = newRetriever();
    try {
      // recall 下它仍被 bm25 命中 (字面相关) ⇒ 证明"关的是通道", 而不是"把它从结果里删了"。
      const hit = r.retrieveSync({ text: RULE, limit: 10, purpose: "recall" } as never);
      expect(hit.hits.some((h) => h.entry.id === "r1")).toBe(true);
      expect([...channels(r, { purpose: "recall" })].some((c) => c !== "rules")).toBe(true);
    } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
  });
});
