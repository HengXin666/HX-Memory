// FileBackend.removeMany 与逐条 remove() 必须同一判据 (2026-11-01, 清知识库时新增的批量入口)。
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileBackend } from "../../src/storage/file-store.ts";

const DAY = "2026-06-13T08:00:00.000Z";

function seed(root: string, hard: boolean): FileBackend {
  const s = new FileBackend({ root, allowTruthDelete: hard });
  for (let i = 0; i < 6; i++) {
    s.add({ id: "doc-" + i, kind: "doc", scope: "global", content: "博客切片 " + i + " 虚幻引擎", source: "kb:blog/p" + i + ".md", ts: { validAt: DAY, assertedAt: DAY }, tags: ["kb"] });
  }
  s.add({ id: "keep-1", kind: "decision", scope: "global", content: "真相放在 Markdown 文件里", source: "dialog", ts: { validAt: DAY, assertedAt: DAY } });
  return s;
}

function truthText(root: string): string {
  const d = join(root, "daily");
  return existsSync(d) ? readdirSync(d).map((f) => readFileSync(join(d, f), "utf8")).join("\n") : "";
}

describe("removeMany", () => {
  it("hard: 与逐条 remove 产物逐字节一致, 索引/FTS/tags 一起清", () => {
    const a = mkdtempSync(join(tmpdir(), "hxmem-bulk-a-"));
    const b = mkdtempSync(join(tmpdir(), "hxmem-bulk-b-"));
    try {
      const sa = seed(a, true);
      const sb = seed(b, true);
      const ids = ["doc-0", "doc-1", "doc-2", "doc-3", "doc-4", "doc-5", "missing"];
      const rep = sa.removeMany(ids);
      for (const id of ids) sb.remove(id);
      expect(rep).toMatchObject({ requested: 7, found: 6, blocksRemoved: 6, mode: "hard" });
      expect(truthText(a)).toBe(truthText(b));
      expect(truthText(a)).toContain("id: keep-1");
      expect(truthText(a)).not.toContain("source: kb:");
      expect(sa.verify().ok).toBe(true);
      expect(sa.get("doc-0")).toBeNull();
      expect(sa.get("keep-1")?.content).toBe("真相放在 Markdown 文件里");
      sa.close();
      sb.close();
      // 重建不复活: 删掉索引, 从真相重开。
      rmSync(join(a, "index.sqlite"), { force: true });
      rmSync(join(a, "index.sqlite-wal"), { force: true });
      rmSync(join(a, "index.sqlite-shm"), { force: true });
      const re = new FileBackend({ root: a });
      expect(re.get("doc-3")).toBeNull();
      expect(re.get("keep-1")).not.toBeNull();
      re.close();
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });

  it("默认 (非 hard): 退化为逐条 shadow, 与治理口径一致", () => {
    const r = mkdtempSync(join(tmpdir(), "hxmem-bulk-s-"));
    try {
      const s = seed(r, false);
      const rep = s.removeMany(["doc-0", "doc-1"]);
      expect(rep.mode).toBe("shadow");
      expect(s.get("doc-0")?.status).toBe("shadow");
      expect(truthText(r)).toContain("id: doc-0");
      s.close();
    } finally {
      rmSync(r, { recursive: true, force: true });
    }
  });

  it("hard: 删 B 时摘掉 A→B 的入边 (真相 + 索引), 重建后也无悬空边", () => {
    const r = mkdtempSync(join(tmpdir(), "hxmem-bulk-in-"));
    try {
      for (const mode of ["many", "single"] as const) {
        const root = join(r, mode);
        const s = new FileBackend({ root, allowTruthDelete: true });
        s.add({ id: "B", kind: "doc", scope: "global", content: "被删的切片", source: "kb:blog/b.md", ts: { validAt: DAY, assertedAt: DAY } });
        s.add({ id: "A", kind: "decision", scope: "global", content: "引用了 B 的决策", source: "dialog", ts: { validAt: DAY, assertedAt: DAY }, relations: [{ type: "relates", toId: "B" }, { type: "relates", toId: "keep-x" }] });
        s.add({ id: "keep-x", kind: "fact", scope: "global", content: "另一条留下的事实", source: "dialog", ts: { validAt: DAY, assertedAt: DAY } });
        if (mode === "many") expect(s.removeMany(["B"]).detachedFrom).toBe(1);
        else s.remove("B");
        expect(s.get("B")).toBeNull();
        expect(s.get("A")?.relations).toEqual([{ type: "relates", toId: "keep-x" }]);
        expect(s.traverse("A", "relates").map((e) => e.id)).toEqual(["keep-x"]);
        expect(s.verify().ok).toBe(true);
        s.close();
        rmSync(join(root, "index.sqlite"), { force: true });
        rmSync(join(root, "index.sqlite-wal"), { force: true });
        rmSync(join(root, "index.sqlite-shm"), { force: true });
        const re = new FileBackend({ root });
        expect(re.get("A")?.relations).toEqual([{ type: "relates", toId: "keep-x" }]);
        expect(re.get("B")).toBeNull();
        re.close();
        expect(truthText(root)).not.toContain("toId: B");
      }
    } finally {
      rmSync(r, { recursive: true, force: true });
    }
  });
});
