// tests/s1/recall.test.ts — S1: 召回服务纯逻辑 (假 query fn, 无存储)。
import { describe, expect, it } from "vitest";
import { RecallService } from "../../src/recall/service.ts";
import type { MemoryEntry, Query } from "../../src/kernel/types.ts";

const DB: MemoryEntry[] = [
  {
    id: "r1",
    kind: "rule",
    content: "所有容器都要显式设计并发上限",
    source: "g",
    scope: "global",
    ts: { validAt: "t", assertedAt: "t" },
    confirmedBy: "u",
    confirmedAt: "t",
  },
  {
    id: "r2",
    kind: "rule",
    content: "生产库禁止直连",
    source: "g",
    scope: "global",
    ts: { validAt: "t", assertedAt: "t" },
    confirmedBy: "u",
    confirmedAt: "t",
  },
  {
    id: "l1",
    kind: "lesson",
    content: "后端队列并发丢消息",
    source: "s",
    scope: "project",
    ts: { validAt: "t", assertedAt: "t" },
  },
  {
    id: "l2",
    kind: "lesson",
    content: "部署忘记健康检查",
    source: "s",
    scope: "project",
    ts: { validAt: "t", assertedAt: "t" },
  },
];

const fakeQuery = (q: Query): MemoryEntry[] => {
  const words = (q.text ?? "").split(" ").filter(Boolean);
  return DB.filter((e) => {
    if (q.kind && e.kind !== q.kind) return false;
    if (q.scope && e.scope !== q.scope) return false;
    if (words.length && !words.some((w) => e.content.includes(w))) return false;
    return true;
  });
};

const svc = new RecallService(fakeQuery);

describe("RecallService", () => {
  it("global confirmed rules always surface regardless of query", () => {
    const out = svc.recall({ text: "随便什么", project: "projA" });
    expect(out.rules.length).toBe(2);
    expect(out.injected).toContain("跨项目规则");
  });

  it("rule ranking prefers query-relevant rules", () => {
    const out = svc.recall({ text: "容器 并发 上限" });
    expect(out.rules[0]!.id).toBe("r1");
  });

  it("project lessons recalled for matching text", () => {
    const out = svc.recall({ text: "队列 并发", project: "projA" });
    expect(out.local.some((e) => e.id === "l1")).toBe(true);
  });

  it("empty text returns just global rules + no local", () => {
    const out = svc.recall({ project: "projA" });
    expect(out.rules.length).toBe(2);
    expect(out.local.length).toBe(0);
  });
});
