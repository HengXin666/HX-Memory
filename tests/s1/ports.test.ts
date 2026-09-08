// tests/s1/ports.test.ts — 内核端口必须"有实现、可断言"。
// 这条测试防的是"端口退化成装饰性文档": MemoryStore/Generalizer/HarnessAdapter
// 曾经没有任何实现或形状对不上, 架构文档却宣称"1 套 API 可换 harness/存储"。
import { describe, expect, it, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileBackend } from "../../src/storage/file-store.ts";
import { GeneralizerService } from "../../src/generalize/service.ts";
import { CodexAdapter } from "../../src/adapters/codex/adapter.ts";
import type {
  Generalizer,
  HarnessAdapter,
  MemoryStore,
  SyncMemoryStore,
} from "../../src/kernel/ports.ts";

const root = mkdtempSync(join(tmpdir(), "hxmem-ports-"));
const store = new FileBackend({ root });
afterAll(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

describe("kernel ports", () => {
  it("FileBackend 满足 MemoryStore (含 remove)", async () => {
    const port: MemoryStore = store;
    const entry = await port.add({
      kind: "fact",
      content: "端口一致性",
      source: "test",
      scope: "agent",
      ts: { validAt: "2026-01-01T00:00:00.000Z", assertedAt: "2026-01-01T00:00:00.000Z" },
    });
    expect(await port.get(entry.id)).not.toBeNull();
    expect((await port.query({ text: "端口一致性" })).length).toBe(1);
    await port.update(entry.id, { content: "端口一致性 (更新)" });
    expect((await port.get(entry.id))?.content).toContain("更新");
    // 关系要真的能走通 (之前这里断言空数组, 是真空断言)
    const other = await port.add({
      kind: "fact",
      content: "被引用的条目",
      source: "test",
      scope: "agent",
      ts: { validAt: "2026-01-01T00:00:00.000Z", assertedAt: "2026-01-01T00:00:00.000Z" },
      relations: [{ type: "relates", toId: entry.id }],
    });
    expect((await port.traverse(other.id, "relates")).map((e) => e.id)).toEqual([entry.id]);
    await port.remove(entry.id);
    expect(await port.get(entry.id)).not.toBeNull(); // 真相仍在, 只是 shadow
    expect((await port.query({ text: "端口一致性" })).length).toBe(0);
    expect(await port.traverse(other.id, "relates")).toEqual([]); // shadow 邻居不可见
  });

  it("FileBackend 同时满足同步查询面 (Binder/RecallService 需要)", () => {
    const sync: SyncMemoryStore = store;
    expect(Array.isArray(sync.query({ limit: 1 }))).toBe(true);
  });

  it("all() 属于端口契约 (warmUp 依赖它)", async () => {
    const port: MemoryStore = store;
    expect(Array.isArray(await port.all())).toBe(true);
  });

  it("GeneralizerService 满足 Generalizer", async () => {
    const port: Generalizer = new GeneralizerService(store, join(root, "review"));
    expect(typeof port.runBatch).toBe("function");
    expect(typeof port.runRecent).toBe("function");
    expect(port.listQueue()).toEqual([]);
    expect((await port.confirm("nope", "u")).ok).toBe(false);
  });

  it("CodexAdapter 满足 HarnessAdapter (pull 式 harness 端口)", () => {
    const port: HarnessAdapter = new CodexAdapter({ store, repoRoot: root });
    expect(port.name).toBe("codex");
  });
});
