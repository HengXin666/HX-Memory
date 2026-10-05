// tests/s2/shadow-source-edges.test.ts — 已撤回的节点不得再从图里扩张。
//
// 真实缺陷 (2026-09-18 实测, 本机真实库 163 条真相条目):
//   generalizes 边共 **60** 条, 其中 **41** 条挂在 10 个**已撤回**的占位草稿 rule 上
//   (那 10 条草稿 status=shadow, 09-15 就被人工否掉了)。全图**度数最高的节点正是一条
//   已撤回的草稿** (10 条边) —— 它被挡住不进注入, 却仍是图里连接度最高的枢纽。
//
// 根因: 撤回走 remove() → 真相文件写 `status: shadow` 且**整块保留 relations**,
// 而 markShadow 只 UPDATE memories —— 索引里那些边一行都没少。
// 而 traverse 只挡"撤回的**邻居**", 漏了"撤回的**源**":
//   SELECT ... WHERE r.from_id = ? AND m.status != 'shadow'   ← 只看了 m (邻居)
// 于是"从一个已被否定的节点继续扩张"在结构上是允许的。
//
// 修在读取侧 (不删数据): 撤回的语义是"保留可审计的撤回记录", 真相文件里那条必须留着;
// 但**从它出发的结构性扩张**在撤回那一刻就该失效 —— 可见性是读取期的性质, 这也让
// **存量 41 条残留边**立刻失效, 不必写数据迁移脚本。
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileBackend } from "../../src/storage/file-store.ts";
import { MemoryBackend } from "../../src/storage/memory-store.ts";
import type { MemoryEntry } from "../../src/kernel/types.ts";

const T = { validAt: "2026-06-01T00:00:00.000Z", assertedAt: "2026-06-01T00:00:00.000Z" };

function lesson(id: string, content: string): MemoryEntry {
  return { id, kind: "lesson", scope: "project", project: "P", content, source: "s", ts: T };
}

/** 一条 rule (草稿或真规则), generalizes 指向给定的实例。 */
function rule(
  id: string,
  content: string,
  targets: string[],
  status?: "shadow" | "active",
): MemoryEntry {
  return {
    id,
    kind: "rule",
    scope: "global",
    content,
    source: "g",
    ts: T,
    ...(status ? { status } : {}),
    confirmedBy: "user:test",
    confirmedAt: T.validAt,
    relations: targets.map((toId) => ({ type: "generalizes" as const, toId })),
  };
}

const DRAFT = "经验: memory 相关的 10 条实例已沉淀, 建议复核提炼为跨项目规则";

describe("traverse: 撤回的源节点不再扩张 (两个后端同口径)", () => {
  let root: string;
  let file: FileBackend;
  let mem: MemoryBackend;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hxmem-shadow-src-"));
    file = new FileBackend({ root });
    mem = new MemoryBackend({});
  });
  afterEach(() => {
    file.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("撤回的草稿: 它的 generalizes 边不再可走 (此前会返回全部实例)", () => {
    mem.add(lesson("i1", "实例一"));
    mem.add(lesson("i2", "实例二"));
    mem.add(rule("rDraft", DRAFT, ["i1", "i2"], "shadow"));
    // 这就是缺陷本身: 修复前这里返回 [i1, i2] —— 一个已被否定的草稿仍在向外扩张。
    expect(mem.traverse("rDraft", "generalizes")).toEqual([]);
  });

  it("存活的真规则: 边照常可走 (不许把能力一起修掉)", () => {
    mem.add(lesson("i1", "实例一"));
    mem.add(rule("rReal", "派生索引必须可全量重建", ["i1"]));
    expect(mem.traverse("rReal", "generalizes").map((e) => e.id)).toEqual(["i1"]);
  });

  it("撤回只挡**源端**扩张; 邻居本身仍作为独立条目存在", () => {
    mem.add(lesson("i1", "实例一"));
    mem.add(rule("rDraft", DRAFT, ["i1"], "shadow"));
    // 实例没有跟着消失 —— 撤回的是"那条草稿", 不是它指向的内容。
    expect(mem.query({ kind: "lesson" }).map((e) => e.id)).toEqual(["i1"]);
  });

  it("FileBackend (走派生索引): 真相文件里撤回的源同样不扩张", () => {
    file.add(lesson("i1", "实例一"));
    file.add(lesson("i2", "实例二"));
    file.add(rule("rDraft", DRAFT, ["i1", "i2"], "shadow"));
    expect(file.traverse("rDraft", "generalizes")).toEqual([]);
  });

  it("FileBackend: 撤回**发生在写完边之后**也立即失效 (存量残留边的修法验证)", () => {
    // 复现真实库里那 41 条边的产生顺序: 先确认成 rule (建边), 之后才被人工撤回。
    file.add(lesson("i1", "实例一"));
    file.add(rule("rDraft", DRAFT, ["i1"]));
    expect(file.traverse("rDraft", "generalizes").map((e) => e.id)).toEqual(["i1"]);
    // 撤回 (默认 false = 写 shadow, 保留可审计记录, 不删块)
    file.remove("rDraft");
    const after = file.get("rDraft");
    expect(after?.status).toBe("shadow"); // 记录仍在 (撤回语义没被改)
    expect(file.traverse("rDraft", "generalizes")).toEqual([]); // 但扩张已失效
  });

  it("撤回的邻居仍不可见 (原有不变量不许回归)", () => {
    mem.add(rule("rReal", "真规则", ["i1"]));
    mem.add({ ...lesson("i1", "被指向的条目"), status: "shadow" } as MemoryEntry);
    expect(mem.traverse("rReal", "generalizes")).toEqual([]);
  });
});
