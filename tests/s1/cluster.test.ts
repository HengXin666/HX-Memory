// tests/s1/cluster.test.ts — S1: 主题聚类纯逻辑。
import { describe, expect, it } from "vitest";
import { clusterByTheme, themeOf } from "../../src/generalize/cluster.ts";

function lesson(id: string, content: string) {
  return {
    id,
    kind: "lesson" as const,
    content,
    source: "s",
    scope: "project" as const,
    ts: { validAt: "2026-09-06", assertedAt: "2026-09-06" },
  };
}

describe("themeOf", () => {
  it("detects concurrency theme from 并发", () => {
    expect(themeOf("后端队列并发踩坑")).toBe("concurrency");
  });
  it("detects idempotency theme from 幂等", () => {
    expect(themeOf("接口要幂等")).toBe("idempotency");
  });
  it("detects timeout theme from 超时/重试", () => {
    expect(themeOf("重试要加超时")).toBe("timeout");
  });
  it("returns null when no theme signal", () => {
    expect(themeOf("今天把文档写完了")).toBeNull();
  });
});

describe("clusterByTheme", () => {
  it("groups same-theme lessons together", () => {
    const clusters = clusterByTheme([
      lesson("a", "后端队列并发, 任务互相覆盖"),
      lesson("b", "另一个服务并发写入竞态"),
      lesson("c", "前端按钮防重复提交 (幂等)"),
    ]);
    const concurrency = clusters.find((c) => c.theme === "concurrency");
    expect(concurrency?.entries.length).toBe(2);
    expect(concurrency?.entries.map((e) => e.id).sort()).toEqual(["a", "b"]);
    const idem = clusters.find((c) => c.theme === "idempotency");
    expect(idem?.entries.length).toBe(1);
  });

  it("ignores non-lesson kinds and theme-less entries", () => {
    const clusters = clusterByTheme([
      lesson("a", "并发竞态问题"),
      {
        id: "f",
        kind: "fact",
        content: "并发无关事实",
        source: "s",
        scope: "project" as const,
        ts: { validAt: "x", assertedAt: "y" },
      },
      lesson("b", "没有主题信号"),
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.entries.map((e) => e.id)).toEqual(["a"]);
  });
});
