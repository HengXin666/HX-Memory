// tests/s1/link.test.ts — 结构关联建边 (标签/实体共现) 的纯逻辑契约。
import { describe, expect, it } from "vitest";
import { planStructuralLinks } from "../../src/evolution/link.ts";
import type { MemoryEntry } from "../../src/kernel/types.ts";

const T = { validAt: "2026-06-01T00:00:00.000Z", assertedAt: "2026-06-01T00:00:00.000Z" };
const e = (id: string, over: Partial<MemoryEntry> = {}): MemoryEntry => ({
  id,
  kind: "lesson",
  content: "内容 " + id,
  source: "t",
  scope: "agent",
  ts: T,
  status: "active",
  ...over,
});

describe("结构关联", () => {
  it("共享实体/标签才建边, 权重随共现强度上升", () => {
    const links = planStructuralLinks({ id: "new", tags: ["concurrency"], entities: ["容器"] }, [
      e("a", { tags: ["concurrency"], entities: ["容器"] }),
      e("b", { tags: ["concurrency"] }),
      e("c", { tags: ["testing"] }),
    ]);
    expect(links.map((l) => l.toId)).toEqual(["a", "b"]);
    expect(links[0]?.weight).toBeGreaterThan(links[1]?.weight ?? 0);
    expect(links.every((l) => l.type === "relates")).toBe(true);
  });

  it("有上限 (默认 3): 关联爆炸比少几条边更糟", () => {
    const existing = Array.from({ length: 10 }, (_, i) => e("m" + i, { tags: ["concurrency"] }));
    expect(planStructuralLinks({ id: "new", tags: ["concurrency"] }, existing).length).toBe(3);
    expect(
      planStructuralLinks({ id: "new", tags: ["concurrency"] }, existing, { maxLinks: 0 }),
    ).toEqual([]);
  });

  it("跳过非 active 与自己; 没有共现则空", () => {
    const links = planStructuralLinks({ id: "new", tags: ["concurrency"] }, [
      e("new", { tags: ["concurrency"] }),
      e("gone", { tags: ["concurrency"], status: "shadow" }),
      e("other", { tags: ["testing"] }),
    ]);
    expect(links).toEqual([]);
  });
});
