// tests/s2/binding-store.test.ts — S2: BindingStore 持久化 + 面板改动即生效。
import { describe, expect, it, afterAll } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BindingStore, BINDINGS_FILE } from "../../src/bindings/store.ts";
import { Binder } from "../../src/kernel/binder.ts";
import { FileBackend } from "../../src/storage/file-store.ts";
import type { MemoryEntry, Query } from "../../src/kernel/types.ts";

let root: string;
const roots: string[] = [];

function mem(entries: MemoryEntry[]) {
  return (q: Query) =>
    entries.filter(
      (e) => (q.kind ? e.kind === q.kind : true) && (q.scope ? e.scope === q.scope : true),
    );
}

describe("BindingStore", () => {
  it("保存后落盘 bindings.json (truth-in-files)", () => {
    root = mkdtempSync(join(tmpdir(), "hxmem-bs-"));
    roots.push(root);
    const bs = new BindingStore(root);
    bs.saveAll([
      {
        project: "proj-web",
        bindings: [{ id: "cross-rules", query: { kind: "rule", scope: "global" } }],
      },
    ]);
    expect(existsSync(join(root, BINDINGS_FILE))).toBe(true);
    const raw = JSON.parse(readFileSync(join(root, BINDINGS_FILE), "utf8"));
    expect(raw[0].project).toBe("proj-web");
  });

  it("重载后配置仍在 (重启不丢)", () => {
    const bs2 = new BindingStore(root);
    expect(bs2.forProject("proj-web")).toHaveLength(1);
  });

  it("面板保存 → Binder 实时读到新绑定 (改动即生效)", () => {
    const rule: MemoryEntry = {
      id: "r9",
      kind: "rule",
      content: "生产发布必须走灰度",
      source: "t",
      scope: "global",
      ts: { validAt: "2026-01-01T00:00:00.000Z", assertedAt: "2026-01-01T00:00:00.000Z" },
      confirmedBy: "u",
      confirmedAt: "t",
    };
    const bs = new BindingStore(root);
    const binder = new Binder(mem([rule]), () => bs.list());
    // 初始无绑定 → 不注入
    bs.saveAll([]);
    expect(binder.injectFor("proj-web", "发布上线")).toBe("");
    // 面板保存绑定 → 下一轮注入 (无需重启, 无模型决策)
    bs.saveAll([
      {
        project: "proj-web",
        bindings: [{ id: "cross-rules", query: { kind: "rule", scope: "global" } }],
      },
    ]);
    expect(binder.injectFor("proj-web", "发布上线")).toContain("灰度");
  });

  it("upsert/remove 语义", () => {
    const bs = new BindingStore(root);
    bs.upsert("proj-b", [{ id: "x", query: {} }]);
    expect(bs.forProject("proj-b")).toHaveLength(1);
    bs.remove("proj-b");
    expect(bs.forProject("proj-b")).toHaveLength(0);
  });
});

afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});
