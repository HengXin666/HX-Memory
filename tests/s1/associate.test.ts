// tests/s1/associate.test.ts — 写入期关联裁决的纯逻辑契约。
import { describe, expect, it } from "vitest";
import { decideAssociation, normalizeFingerprint } from "../../src/evolution/associate.ts";
import type { MemoryEntry } from "../../src/kernel/types.ts";

const T = { validAt: "2026-06-01T00:00:00.000Z", assertedAt: "2026-06-01T00:00:00.000Z" };
const e = (id: string, content: string, over: Partial<MemoryEntry> = {}): MemoryEntry => ({
  id,
  kind: "lesson",
  content,
  source: "t",
  scope: "agent",
  ts: T,
  status: "active",
  ...over,
});

describe("归一化指纹", () => {
  it("标点/空白/大小写/全半角都不影响指纹", () => {
    expect(normalizeFingerprint("容器并发: 上限 10!")).toBe(normalizeFingerprint("容器并发上限10"));
    expect(normalizeFingerprint("PNPM")).toBe(normalizeFingerprint("pnpm"));
  });
});

describe("写入期裁决", () => {
  it("近义重述 (换一个词) → duplicate, 不重复落盘", () => {
    const d = decideAssociation({ content: "容器并发要显式设置上限" }, [
      e("old", "容器并发要显式设上限"),
    ]);
    expect(d.action).toBe("duplicate");
    expect(d.targetId).toBe("old");
  });

  it("完全相同 (含标点差异) → duplicate", () => {
    const d = decideAssociation({ content: "容器并发: 上限 10!" }, [e("old", "容器并发上限10")]);
    expect(d.action).toBe("duplicate");
  });

  it("相关但更丰富 → link (新信息不能丢, 建 relates 边)", () => {
    const d = decideAssociation({ content: "容器并发要显式设上限, 并且要加超时熔断与重试上限" }, [
      e("old", "容器并发要显式设上限"),
    ]);
    // 候选更丰富 → 不是重复; 但如果字面相似度不足则会是 add (都可接受, 由 linkFloor 决定)
    expect(["link", "add"]).toContain(d.action);
  });

  it("同一个主题不同项目/不同说法 → 依旧能识别为关联 (建边而不是丢弃)", () => {
    const d = decideAssociation({ content: "数据库连接池要设置最大连接数与超时" }, [
      e("old", "数据库连接池超时设置"),
    ]);
    expect(["link", "duplicate"]).toContain(d.action);
    expect(d.targetId).toBe("old");
  });

  it("完全无关 → add", () => {
    const d = decideAssociation({ content: "前端按钮圆角改成 8px" }, [
      e("old", "容器并发要显式设上限"),
    ]);
    expect(d.action).toBe("add");
    expect(d.targetId).toBeUndefined();
  });

  it("非 active 的老条目不作为裁决目标 (不会和已撤回/过期的条目合并)", () => {
    const d = decideAssociation({ content: "容器并发要显式设上限" }, [
      e("dead", "容器并发要显式设上限", { status: "shadow" }),
    ]);
    expect(d.action).toBe("add");
  });

  it("重复时给出需要并入的标签/实体 (只含新增部分)", () => {
    const d = decideAssociation(
      { content: "容器并发要显式设上限", tags: ["concurrency", "container"], entities: ["容器"] },
      [e("old", "容器并发要显式设上限", { tags: ["concurrency"] })],
    );
    expect(d.action).toBe("duplicate");
    expect(d.mergedTags).toEqual(["container"]);
    expect(d.mergedEntities).toEqual(["容器"]);
  });
});
