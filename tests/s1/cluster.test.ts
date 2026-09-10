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
    expect(themeOf("今天天气不错")).toBeNull();
  });
  it("扩充后的字典覆盖接口/性能/依赖/类型这类常见工程主题", () => {
    expect(themeOf("接口契约要写清楚")).toBe("api");
    expect(themeOf("这个查询延迟太高")).toBe("performance");
    // 注意: "锁" 属于 concurrency 的既有信号 (字典按序首个命中优先), 因此这里避开它。
    expect(themeOf("第三方依赖不要浮动版本")).toBe("dependency");
    expect(themeOf("tsc 编译不过")).toBe("typescript");
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

  it("主路径聚不到主题时, 共享标签 (>=2 条) 形成回退簇", () => {
    const tagged = (id: string, content: string, tags: string[]) => ({
      ...lesson(id, content),
      tags,
    });
    const clusters = clusterByTheme([
      tagged("a", "先写用例再实现", ["方法论"]),
      tagged("b", "改动前先补验证", ["方法论"]),
      tagged("c", "这个只能算一条孤例", ["独有标签"]),
    ]);
    const fallback = clusters.find((c) => c.theme === "tag:方法论");
    expect(fallback?.entries.map((e) => e.id).sort()).toEqual(["a", "b"]);
    // 只出现一次的标签不聚簇 (否则会退化成"每条一个簇")。
    expect(clusters.some((c) => c.theme === "tag:独有标签")).toBe(false);
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
      lesson("b", "无从归类的记录"),
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.entries.map((e) => e.id)).toEqual(["a"]);
  });
});
