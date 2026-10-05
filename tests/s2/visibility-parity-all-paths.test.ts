// tests/s2/visibility-parity-all-paths.test.ts — **每条读路径**都必须与 `isLiveEntry` 同口径。
//
// 为什么需要它 (2026-09-18, §686/§689): 可见性的**权威定义**只有一处 ——
// `retrieval/lifecycle.ts` 的 `isLiveEntry`: "shadow (人工撤回) / merged (已并入他条) /
// expired (衰减过期) 都不参与检索"。而实现里**三条读路径各自写了一遍 SQL**:
//
// | 路径 | 修复前 |
// | --- | --- |
// | `query()` | 只挡 `shadow` ✗ (§686 修) |
// | `recent()` | 只挡 `shadow` ✗ (§689 修) |
// | `graph-reader.out/incoming()` | 只挡 `shadow` ✗ (§689 修) |
//
// 而 `recent()` 那条**早就有契约注释声明了它该做什么** (`gateway.ts` 的
// "可见性 (shadow/merged/expired 默认隐藏) 与排序口径只有一处 —— 面板不该看到已撤回的条目")。
//
// ⇒ 本测试把"每条路径"都对着**权威函数**断言, 而不是写死一份名单。
//    将来那条定义改了, 这里**自动跟着改**。
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileBackend } from "../../src/storage/file-store.ts";
import { isLiveEntry } from "../../src/retrieval/lifecycle.ts";
import type { MemoryEntry } from "../../src/kernel/types.ts";

const T = { validAt: "2026-01-01T00:00:00Z", assertedAt: "2026-01-01T00:00:00Z" };
const STATUSES = ["active", "shadow", "merged", "expired", "superseded"] as const;

function newRoot(): string {
  return mkdtempSync(join(tmpdir(), "vispaths-"));
}

/** 一条"种子"指向每条状态条目 (graph 通道的边)。 */
function seedOf(status: string): MemoryEntry {
  return {
    id: "seed-" + status, kind: "lesson", content: "种子 " + status, source: "t", scope: "agent", ts: T,
    relations: [{ type: "relates", toId: "t-" + status }],
  } as MemoryEntry;
}

function mkStatus(status: string): MemoryEntry {
  return { id: "t-" + status, kind: "lesson", content: "目标 " + status, source: "t", scope: "agent", ts: T } as MemoryEntry;
}

describe("可见性口径: 每条读路径都对齐 isLiveEntry", () => {
  it("**recent() 与 query() 一致** (修复前 recent 放行 merged/expired)", () => {
    const root = newRoot();
    const store = new FileBackend({ root });
    try {
      for (const st of STATUSES) {
        store.add(mkStatus(st));
        if (st !== "active") store.update("t-" + st, { status: st } as never);
      }
      const rec = new Set(store.recent(100).map((e) => e.id));
      const q = new Set(store.query({ limit: 100 }).map((e) => e.id));
      for (const st of STATUSES) {
        const live = isLiveEntry({ status: st });
        expect(rec.has("t-" + st), "recent 对 " + st + " 的可见性应与 isLiveEntry 一致").toBe(live);
        expect(q.has("t-" + st), "query 对 " + st + " 的可见性应与 isLiveEntry 一致").toBe(live);
      }
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("**traverse() 的邻居必须活着** (修复前放行 merged/expired 的邻居)", () => {
    const root = newRoot();
    const store = new FileBackend({ root });
    try {
      for (const st of STATUSES) {
        store.add(seedOf(st));
        store.add(mkStatus(st));
        if (st !== "active") store.update("t-" + st, { status: st } as never);
      }
      for (const st of STATUSES) {
        const got = store.traverse("seed-" + st, "relates").map((e) => e.id);
        expect(
          got.includes("t-" + st),
          "traverse 对 " + st + " 邻居的可见性应与 isLiveEntry 一致",
        ).toBe(isLiveEntry({ status: st }));
      }
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("**源端不活着时 traverse 返回空** (两端都要判)", () => {
    const root = newRoot();
    const store = new FileBackend({ root });
    try {
      store.add(seedOf("x"));
      store.add(mkStatus("x"));
      store.update("seed-x", { status: "expired" } as never);
      expect(store.traverse("seed-x", "relates")).toHaveLength(0);
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
