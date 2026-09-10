// tests/s2/evolution-fields.test.ts — 演化字段 (v2) 的往返无损与 fail-closed 边界。
//
// 这些字段决定"记忆怎么被更新/遗忘/关联", 所以它们必须在**真相文件**里, 而不是只活在索引里:
// 一旦只存索引, 删库重建 (换引擎/索引损坏) 就会静默丢掉关联性、衰减状态与血缘。
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileBackend } from "../../src/storage/file-store.ts";
import type { MemoryEntryInput } from "../../src/kernel/types.ts";

let root: string;
let store: FileBackend;
const T = { validAt: "2026-06-01T00:00:00.000Z", assertedAt: "2026-06-01T00:00:00.000Z" };

function rich(over: Partial<MemoryEntryInput> = {}): MemoryEntryInput {
  return {
    id: "v2-full",
    kind: "lesson",
    content: "容器并发要显式设上限",
    source: "session:s1",
    scope: "project",
    project: "api",
    ts: T,
    entities: ["容器", "并发"],
    importance: 9,
    confidence: 0.8,
    reinforcement: 3,
    lastHitAt: "2026-06-02T00:00:00.000Z",
    expiresAt: "2027-06-01T00:00:00.000Z",
    derivedFrom: ["ep-1", "ep-2"],
    mergedFrom: ["old-1"],
    relations: [{ type: "mentions", toId: "容器", weight: 0.7 }],
    ...over,
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hxmem-v2-"));
  store = new FileBackend({ root });
});
afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

describe("演化字段 (v2): 真相 → 索引 → 真相 往返无损", () => {
  it("写入后 get() 拿到全部字段", () => {
    store.add(rich());
    const e = store.get("v2-full");
    expect(e?.entities).toEqual(["容器", "并发"]);
    expect(e?.importance).toBe(9);
    expect(e?.confidence).toBeCloseTo(0.8);
    expect(e?.reinforcement).toBe(3);
    expect(e?.lastHitAt).toBe("2026-06-02T00:00:00.000Z");
    expect(e?.expiresAt).toBe("2027-06-01T00:00:00.000Z");
    expect(e?.derivedFrom).toEqual(["ep-1", "ep-2"]);
    expect(e?.mergedFrom).toEqual(["old-1"]);
    expect(e?.relations).toEqual([{ type: "mentions", toId: "容器", weight: 0.7 }]);
  });

  it("删库重建 (rebuildFromFiles) 后字段逐个相等 —— 否则换引擎就丢语义", () => {
    const before = store.add(rich());
    store.rebuildFromFiles();
    expect(store.get("v2-full")).toEqual(before);
  });

  it("字段真的写进了人可读的 frontmatter", () => {
    store.add(rich());
    const file = readFileSync(join(root, "digest", "2026-06-01.md"), "utf8");
    for (const needle of [
      "entities: [",
      "importance: 9",
      "confidence: 0.8",
      "reinforcement: 3",
      "last_hit_at: 2026-06-02T00:00:00.000Z",
      "expires_at: 2027-06-01T00:00:00.000Z",
      "derived_from: [",
      "merged_from: [",
      '"mentions"',
    ]) {
      expect(file).toContain(needle);
    }
  });

  it("新状态 merged/expired 可写入并被重建读回 (遗忘是可逆状态, 不是删除)", () => {
    store.add(rich({ id: "m1", status: "merged" }));
    store.add(rich({ id: "x1", status: "expired" }));
    store.rebuildFromFiles();
    expect(store.get("m1")?.status).toBe("merged");
    expect(store.get("x1")?.status).toBe("expired");
  });

  it("v1 老文件 (无新字段) 仍能解析: 字段为 undefined, 不报错", () => {
    store.add({
      id: "legacy",
      kind: "fact",
      content: "老记忆",
      source: "s",
      scope: "agent",
      ts: T,
    });
    store.close();
    store = new FileBackend({ root });
    const e = store.get("legacy");
    expect(e?.content).toBe("老记忆");
    expect(e?.entities).toBeUndefined();
    expect(e?.importance).toBeUndefined();
  });
});

describe("演化字段 (v2): 边界与 fail-closed", () => {
  it("非法数值在写入时拒绝 (importance 越界被收敛, 非数字抛错)", () => {
    const e = store.add(rich({ id: "clamp", importance: 99 }));
    expect(e.importance).toBe(10);
    expect(() => store.add(rich({ id: "bad", importance: Number.NaN }))).toThrow(/importance/);
  });

  it("非法时间戳在写入时拒绝 (lastHitAt 参与衰减计算, 坏了会让排序静默失真)", () => {
    expect(() => store.add(rich({ id: "bad-time", lastHitAt: "yesterday" }))).toThrow(/lastHitAt/);
  });

  it("手工编辑出的坏字段只丢该字段并记 warning, 不让整条记忆消失", () => {
    store.add(rich({ id: "hand" }));
    const file = join(root, "digest", "2026-06-01.md");
    const text = readFileSync(file, "utf8").replace("importance: 9", "importance: 很高");
    writeFileSync(file, text, "utf8");
    store.rebuildFromFiles();
    const e = store.get("hand");
    expect(e).not.toBeNull();
    expect(e?.importance).toBeUndefined();
    expect(e?.content).toBe("容器并发要显式设上限");
    expect(store.warnings().some((w) => w.includes("importance"))).toBe(true);
  });

  it("非法状态仍然整条拒绝 (状态是可见性开关, 不能猜)", () => {
    store.add(rich({ id: "keep" }));
    const file = join(root, "digest", "2026-06-01.md");
    const text = readFileSync(file, "utf8").replace("status: active", "status: zombie");
    writeFileSync(file, text, "utf8");
    store.rebuildFromFiles();
    expect(store.get("keep")).toBeNull();
    expect(store.warnings().some((w) => w.includes("invalid status"))).toBe(true);
  });
});
