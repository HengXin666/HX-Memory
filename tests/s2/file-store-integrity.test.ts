// tests/s2/file-store-integrity.test.ts — 存储层数据完整性回归。
// 覆盖四个真实踩过的坑:
//   1. 同一 id 二次写入 (update/add) 只替换 frontmatter, 旧正文残留 → 真相文件被写坏;
//   2. rebuildFromFiles() 丢 relations → 演化链/推广关联在重建后消失;
//   3. remove() 只改索引 → query 仍能命中, 重建后还复活;
//   4. warmUp/all() 被默认 limit=50 截断 → 老记忆重复捕获。
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileBackend } from "../../src/storage/file-store.ts";
import type { MemoryEntryInput } from "../../src/kernel/types.ts";

let root: string;
let store: FileBackend;

const T = { validAt: "2026-05-01T00:00:00.000Z", assertedAt: "2026-05-01T00:00:00.000Z" };

function entry(over: Partial<MemoryEntryInput> = {}): MemoryEntryInput {
  return {
    kind: "lesson",
    content: "容器并发要显式设上限",
    source: "session:s1",
    scope: "project",
    project: "api",
    ts: T,
    ...over,
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hxmem-integrity-"));
  store = new FileBackend({ root });
});
afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

describe("真相文件写入 (upsert 精确切片)", () => {
  it("同一 id 更新后文件里只有一份正文, 重建后内容正确", () => {
    const e = store.add(entry({ id: "e1", content: "第一版正文" }));
    store.update(e.id, { content: "第二版正文" });
    const file = readFileSync(join(root, "digest", "2026-05-01.md"), "utf8");
    expect(file).not.toContain("第一版正文");
    expect(file.match(/第二版正文/g)?.length).toBe(1);
    store.rebuildFromFiles();
    expect(store.get("e1")?.content).toBe("第二版正文");
  });

  it("同一 id 重复 add 不产生残留块 (去重漏掉时也不会写坏文件)", () => {
    store.add(entry({ id: "e2", content: "重复写入" }));
    store.add(entry({ id: "e2", content: "重复写入" }));
    const file = readFileSync(join(root, "digest", "2026-05-01.md"), "utf8");
    expect(file.match(/id: e2/g)?.length).toBe(1);
    expect(file.match(/重复写入/g)?.length).toBe(1);
    store.rebuildFromFiles();
    expect(store.get("e2")?.content).toBe("重复写入");
  });

  it("同日多条条目互不覆盖", () => {
    store.add(entry({ id: "a1", content: "条目 A" }));
    store.add(entry({ id: "a2", content: "条目 B" }));
    store.rebuildFromFiles();
    expect(store.get("a1")?.content).toBe("条目 A");
    expect(store.get("a2")?.content).toBe("条目 B");
  });
});

describe("索引可重建 (真相 → 索引)", () => {
  it("relations 在 rebuild 后仍然可用", () => {
    const old = store.add(entry({ id: "r1", content: "旧结论" }));
    const fresh = store.add(
      entry({
        id: "r2",
        content: "新结论",
        relations: [
          { type: "supersedes", toId: old.id },
          { type: "relates", toId: old.id, weight: 0.5 },
        ],
      }),
    );
    expect(store.traverse(fresh.id, "supersedes").map((x) => x.id)).toEqual(["r1"]);
    store.rebuildFromFiles();
    expect(store.traverse("r2", "supersedes").map((x) => x.id)).toEqual(["r1"]);
    expect(store.get("r2")?.relations?.find((r) => r.type === "relates")?.weight).toBe(0.5);
  });

  it("tags 与 structured 在 rebuild 后保留", () => {
    store.add(
      entry({
        id: "t1",
        content: "并发上限",
        tags: ["concurrency", "container"],
        structured: { summary: "摘要", points: ["要点1"] },
      }),
    );
    store.rebuildFromFiles();
    expect(store.get("t1")?.tags).toEqual(["concurrency", "container"]);
    expect(store.get("t1")?.structured?.summary).toBe("摘要");
  });

  it("正文以 '## relations' 开头也不会被误当成关联区段", () => {
    const content = "## relations\n- 这是正文里的字面内容, 不是元数据";
    store.add(entry({ id: "c1", content }));
    store.rebuildFromFiles();
    expect(store.get("c1")?.content).toBe(content);
    expect(store.get("c1")?.relations).toBeUndefined();
  });

  it("旧格式 (## relations 区段) 仍然能读回关联", () => {
    const legacy = [
      "---",
      "id: legacy1",
      "kind: lesson",
      "source: s",
      "scope: project",
      "valid_at: 2026-05-01T00:00:00.000Z",
      "asserted_at: 2026-05-01T00:00:00.000Z",
      "status: active",
      "project: api",
      "---",
      "",
      "## relations",
      "- supersedes: old1 (w=0.5)",
      "",
      "旧格式正文",
      "",
    ].join("\n");
    writeFileSync(join(root, "digest", "2026-05-01.md"), legacy, "utf8");
    store.rebuildFromFiles();
    expect(store.get("legacy1")?.content).toBe("旧格式正文");
    expect(store.get("legacy1")?.relations).toEqual([
      { type: "supersedes", toId: "old1", weight: 0.5 },
    ]);
  });

  it("update 不丢 tags", () => {
    store.add(entry({ id: "u1", tags: ["keep-me"] }));
    store.update("u1", { content: "改过的内容" });
    expect(store.get("u1")?.tags).toEqual(["keep-me"]);
  });
});

describe("撤回 (remove) 的语义", () => {
  it("remove 后 query 不再命中, 但 get 仍可取到 (真相不删)", () => {
    const e = store.add(entry({ id: "d1", content: "要被撤回的记忆" }));
    store.remove(e.id);
    expect(store.query({ text: "要被撤回的记忆" }).length).toBe(0);
    expect(store.recent(10).length).toBe(0);
    expect(store.get(e.id)?.status).toBe("shadow");
  });

  it("remove 后 rebuild 不复活", () => {
    const e = store.add(entry({ id: "d2", content: "撤回后不该复活" }));
    store.remove(e.id);
    store.rebuildFromFiles();
    expect(store.query({ text: "撤回后不该复活" }).length).toBe(0);
    expect(store.get("d2")?.status).toBe("shadow");
  });

  it("includeShadow 可显式取回", () => {
    const e = store.add(entry({ id: "d3", content: "shadow 可见性" }));
    store.remove(e.id);
    expect(store.query({ text: "shadow 可见性", includeShadow: true }).length).toBe(1);
  });
});

describe("全量读取 (warmUp 用)", () => {
  it("all() 不被默认 limit 截断", () => {
    for (let i = 0; i < 60; i++) {
      store.add(
        entry({
          id: "f" + i,
          content: "filler " + i,
          ts: { validAt: "2026-05-02T00:00:00.000Z", assertedAt: "2026-05-02T00:00:00.000Z" },
        }),
      );
    }
    expect(store.query({}).length).toBe(50); // 默认 limit
    expect(store.all().length).toBe(60);
  });
});
