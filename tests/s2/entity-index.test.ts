// tests/s2/entity-index.test.ts — S2: 实体倒排 (索引侧的兜底抽取 + 反查 + 旧库回填)。
//
// 为什么这一层必须单独钉住: 实体反查的**收益全在"旧条目也能被反查到"**。
// 兜底抽取器上线前入库的条目 entities 字段是空的 —— 若回填漏了, 反查对它们永远空转,
// 而这件事**不会报错**, 只会静默少召回 (同一个坑在 FTS 回填上已经踩过一次)。
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { FileBackend } from "../../src/storage/file-store.ts";
import { entityKey } from "../../src/kernel/entity.ts";

let root: string;
let store: FileBackend;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hxmem-entidx-"));
  store = new FileBackend({ root, allowTruthDelete: true });
});
afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

/** 直接写一条没有 entities 字段的"老形态"条目 (模拟兜底抽取器上线前入库的数据)。 */
function addLegacy(id: string, content: string): void {
  store.add({ id, kind: "fact", content, source: "test", scope: "agent" });
}

describe("实体倒排: 写入与反查", () => {
  it("显式 entities 进倒排 (结构化器给的值是权威)", () => {
    store.add({
      id: "m1",
      kind: "fact",
      content: "无关正文",
      source: "t",
      scope: "agent",
      entities: ["HX-Memory"],
    });
    expect(store.byEntities(["hx-memory"]).map((e) => e.id)).toEqual(["m1"]);
    expect(store.entityStatus().entries).toBe(1);
  });

  it("**没有 entities 字段的条目也进倒排** (靠确定性抽取兜底)", () => {
    addLegacy("m2", "prestep.ts 走 FTS5 词面通道");
    const hit = store.byEntities([entityKey("FTS5")]).map((e) => e.id);
    expect(hit).toEqual(["m2"]);
  });

  it("反查键大小写/写法无关 (规范化在查的一侧也生效)", () => {
    addLegacy("m3", "依赖 ADR-023");
    expect(store.byEntities(["ADR-023"]).map((e) => e.id)).toEqual(["m3"]);
    expect(store.byEntities(["adr-023"]).map((e) => e.id)).toEqual(["m3"]);
  });

  it("Query.entity 是**结构化筛选** (与 tag 同一档), 大小写归一", () => {
    addLegacy("m4", "依赖 ADR-023");
    addLegacy("m5", "依赖 FTS5");
    expect(store.query({ entity: "ADR-023" }).map((e) => e.id)).toEqual(["m4"]);
    expect(store.query({ entity: "adr-023" }).map((e) => e.id)).toEqual(["m4"]);
    expect(store.query({ entity: "MEMORY" })).toEqual([]);
  });

  it("反查遵守可见性: 已撤回 (shadow) 的不返回", () => {
    addLegacy("m6", "依赖 ADR-023");
    store.remove("m6");
    expect(store.byEntities(["ADR-023"])).toEqual([]);
    expect(store.query({ entity: "ADR-023" })).toEqual([]);
  });

  it("更新条目时旧实体会被清掉 (否则会留下查得到的幽灵关联)", () => {
    addLegacy("m7", "依赖 ADR-023");
    expect(store.byEntities(["ADR-023"]).map((e) => e.id)).toEqual(["m7"]);
    store.update("m7", { content: "改成依赖 FTS5" });
    expect(store.byEntities(["ADR-023"])).toEqual([]);
    expect(store.byEntities(["FTS5"]).map((e) => e.id)).toEqual(["m7"]);
  });

  it("彻底删除条目时倒排行一并删掉", () => {
    addLegacy("m8", "依赖 ADR-023");
    store.remove("m8");
    expect(store.byEntities(["ADR-023"])).toEqual([]);
  });

  it("空键列表安全返回 (不产生 'IN ()' 这种语法错)", () => {
    addLegacy("m9", "依赖 ADR-023");
    expect(store.byEntities([])).toEqual([]);
    expect(store.byEntities(["", "  "])).toEqual([]);
  });
});

describe("实体倒排: 旧库回填 (升级路径)", () => {
  /** 模拟"实体倒排存在之前"的库: 有 memories 行, entities 表被清空且没有版本水位。 */
  function simulateOldLibrary(): void {
    const db = new DatabaseSync(store.indexFile);
    db.exec("DELETE FROM entities; DELETE FROM index_meta WHERE key = 'entity_version';");
    db.close();
    store.close();
  }

  it("老库 (没有水位) 打开时自动回填, 且**新开连接**能反查到", () => {
    addLegacy("m10", "prestep.ts 走 FTS5");
    simulateOldLibrary();
    const reopened = new FileBackend({ root, allowTruthDelete: true });
    try {
      expect(reopened.entityStatus().version).not.toBe("none");
      expect(reopened.byEntities(["FTS5"]).map((e) => e.id)).toEqual(["m10"]);
    } finally {
      reopened.close();
    }
    store = new FileBackend({ root, allowTruthDelete: true });
  });

  it("回填是幂等的: 连续打开两次不会重复计数, 也不会漏", () => {
    addLegacy("m11", "依赖 FTS5 与 ADR-023");
    simulateOldLibrary();
    const first = new FileBackend({ root, allowTruthDelete: true });
    const a = first.entityStatus();
    first.close();
    const second = new FileBackend({ root, allowTruthDelete: true });
    const b = second.entityStatus();
    second.close();
    expect(b.rows).toBe(a.rows);
    expect(b.entries).toBe(a.entries);
    store = new FileBackend({ root, allowTruthDelete: true });
  });

  it("空库不会因为回填而写入水位 (没有条目时不该假装抽过)", () => {
    store.close();
    const fresh = new FileBackend({ root: mkdtempSync(join(tmpdir(), "hxmem-empty-")) });
    expect(fresh.entityStatus().version).toBe("none");
    fresh.close();
    store = new FileBackend({ root, allowTruthDelete: true });
  });

  it("重建索引 (rebuildFromTruth) 之后倒排仍然可用", () => {
    addLegacy("m12", "依赖 ADR-023");
    expect(store.rebuildFromTruth()).toBe(1);
    expect(store.byEntities(["ADR-023"]).map((e) => e.id)).toEqual(["m12"]);
  });
});
