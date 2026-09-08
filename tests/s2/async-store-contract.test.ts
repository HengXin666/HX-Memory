// tests/s2/async-store-contract.test.ts — 端口允许异步后端时, confirm 必须 await。
// 坑: confirm 同步写时, 异步 store 下会出现"提议标记 confirmed 但 rule 没落盘"。
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileBackend } from "../../src/storage/file-store.ts";
import { GeneralizerService } from "../../src/generalize/service.ts";
import type { MemoryEntry, MemoryEntryInput, Query } from "../../src/kernel/types.ts";
import type { MemoryStore } from "../../src/kernel/ports.ts";

/** 把同步 FileBackend 包成"每个方法都异步"的存储, 模拟未来的异步后端。 */
function asyncStore(inner: FileBackend): MemoryStore {
  const tick = () => new Promise<void>((r) => setTimeout(r, 0));
  return {
    async add(entry: MemoryEntryInput) {
      await tick();
      return inner.add(entry);
    },
    async get(id: string) {
      await tick();
      return inner.get(id);
    },
    async query(q: Query) {
      await tick();
      return inner.query(q);
    },
    async all() {
      await tick();
      return inner.all();
    },
    async traverse(fromId: string, type: string) {
      await tick();
      return inner.traverse(fromId, type);
    },
    async update(id: string, patch: Partial<MemoryEntry>) {
      await tick();
      inner.update(id, patch);
    },
    async remove(id: string) {
      await tick();
      inner.remove(id);
    },
  };
}

describe("异步存储下的 confirm", () => {
  it("confirm 等待落盘: 返回 ok 时 rule 一定在库里", async () => {
    const root = mkdtempSync(join(tmpdir(), "hxmem-async-"));
    const inner = new FileBackend({ root });
    try {
      const g = new GeneralizerService(asyncStore(inner), join(root, "review"));
      const p = g.enqueueProposal({ rule: "异步后端也要落盘" });
      const res = await g.confirm(p.id, "user:test");
      expect(res.ok).toBe(true);
      expect(inner.query({ kind: "rule" })).toHaveLength(1);
      expect(g.listQueue("confirmed")).toHaveLength(1);
    } finally {
      inner.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("落盘失败时不标记 confirmed", async () => {
    const root = mkdtempSync(join(tmpdir(), "hxmem-async-fail-"));
    const inner = new FileBackend({ root });
    try {
      const failing: MemoryStore = {
        ...asyncStore(inner),
        async add() {
          throw new Error("disk full");
        },
      };
      const g = new GeneralizerService(failing, join(root, "review"));
      const p = g.enqueueProposal({ rule: "落盘会失败" });
      const res = await g.confirm(p.id, "user:test");
      expect(res.ok).toBe(false);
      expect(res.error).toContain("disk full");
      expect(g.listQueue("proposed")).toHaveLength(1); // 仍可重试
      expect(g.listQueue("confirmed")).toHaveLength(0);
    } finally {
      inner.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
