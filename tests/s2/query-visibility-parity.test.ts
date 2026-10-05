// tests/s2/query-visibility-parity.test.ts — `query` 与 `searchText` 的可见性口径必须一致。
//
// 为什么需要它 (2026-09-18, §686 实测缺陷): 可见性的**权威定义**在 `retrieval/lifecycle.ts`:
// "shadow (人工撤回) / merged (已并入他条) / expired (衰减过期) 都不参与检索"。
// 而 `index-reader.ts` 的 `query()` 此前**只挡了 shadow**, 而 `searchText()` 用了完整的 HIDDEN 集
// ⇒ **同一份库, 全文检索看不到的 expired 条目, 结构化查询却看得到**。
//
// 影响面 (实测确认): `contradictions` (面板列矛盾对) 与 `memoryQuery` 的 **LIKE 降级分支**
// 都走 `query`; 而 `app/consolidate.ts` 真的会产出 `expired` (TTL 到期) —— 所以不是理论问题。
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemoryStack } from "../../src/app/stack.ts";
import { isLiveEntry } from "../../src/retrieval/lifecycle.ts";

const STATUSES = ["active", "shadow", "merged", "expired", "superseded"] as const;

describe("可见性口径: query / searchText / isLiveEntry 三者一致", () => {
  it("**query({}) 只放行 isLiveEntry 认为活着的条目** (修复前漏了 merged/expired)", () => {
    const root = mkdtempSync(join(tmpdir(), "vis-"));
    const stack = openMemoryStack(root, { episodeRetentionDays: 0, embedder: null });
    try {
      const now = new Date().toISOString();
      const byStatus = new Map<string, string>();
      for (const st of STATUSES) {
        const e = stack.store.add({
          kind: "preference", content: "可见性测试 " + st, source: "s", scope: "agent",
          ts: { validAt: now, assertedAt: now },
        } as never);
        if (st !== "active") stack.store.update(e.id, { status: st } as never);
        byStatus.set(st, e.id);
      }
      const returned = new Set(stack.store.query({ limit: 100 }).map((e) => e.id));

      // 判据不是"我记得该排除谁", 而是**权威定义本身** —— 两者必须逐项一致。
      for (const st of STATUSES) {
        const shouldBeVisible = isLiveEntry({ status: st });
        expect(
          returned.has(byStatus.get(st)!),
          st + " 的可见性应与 isLiveEntry 一致 (它判 " + shouldBeVisible + ")",
        ).toBe(shouldBeVisible);
      }
    } finally {
      stack.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("**searchText 与 query 排除同一批** (两条主路径口径不得分叉)", () => {
    const root = mkdtempSync(join(tmpdir(), "vis2-"));
    const stack = openMemoryStack(root, { episodeRetentionDays: 0, embedder: null });
    try {
      const now = new Date().toISOString();
      const ids: string[] = [];
      for (const st of STATUSES) {
        const e = stack.store.add({
          kind: "preference", content: "同口径检索探针 " + st, source: "s", scope: "agent",
          ts: { validAt: now, assertedAt: now },
        } as never);
        if (st !== "active") stack.store.update(e.id, { status: st } as never);
        ids.push(e.id);
      }
      const q = new Set(stack.store.query({ limit: 100 }).map((e) => e.id));
      const s = new Set(stack.store.searchText("同口径检索探针", 100).map((e) => e.id));
      // ⚠ 不是要求两个集合相等 (searchText 还有相关性门槛), 而是**query 不该多放行**。
      const extraInQuery = [...q].filter((id) => !s.has(id));
      expect(extraInQuery, "query 放行了 searchText 不返回的条目 ⇒ 口径分叉").toHaveLength(0);
    } finally {
      stack.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("includeShadow 仍能放行 shadow (契约不变)", () => {
    const root = mkdtempSync(join(tmpdir(), "vis3-"));
    const stack = openMemoryStack(root, { episodeRetentionDays: 0, embedder: null });
    try {
      const now = new Date().toISOString();
      const e = stack.store.add({
        kind: "preference", content: "将撤回", source: "s", scope: "agent",
        ts: { validAt: now, assertedAt: now },
      } as never);
      stack.store.remove(e.id);
      expect(stack.store.query({ limit: 10 }).map((x) => x.id)).not.toContain(e.id);
      expect(stack.store.query({ limit: 10, includeShadow: true }).map((x) => x.id)).toContain(e.id);
    } finally {
      stack.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
