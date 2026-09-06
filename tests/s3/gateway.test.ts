// tests/s3/gateway.test.ts — S3: 验证 gateway 的 RPC 逻辑 (不依赖真实 DSH Web, 只测方法)。
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileBackend } from "../../src/storage/file-store.ts";
import { GeneralizerService } from "../../src/generalize/service.ts";

// 不实例化 cordis Context (太重), 直接验证 gateway 依赖端口可用。
// 真正的 RPC 桥接由 DSH host 提供; 这里保证: 队列视图 + 确认/驳回逻辑正确。
let root: string;
let store: FileBackend;
let generalizer: GeneralizerService;

function mkLesson(id: string, content: string) {
  return {
    id,
    kind: "lesson" as const,
    content,
    source: "s" + id,
    scope: "project" as const,
    ts: { validAt: "2026-09-06T00:00:00.000Z", assertedAt: "2026-09-06T00:00:00.000Z" },
  };
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "hxmem-gw-"));
  store = new FileBackend({ root });
  generalizer = new GeneralizerService(store, join(root, "review"));
  store.add(mkLesson("a", "队列并发丢消息"));
  store.add(mkLesson("b", "网关并发竞态"));
});

afterAll(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

describe("gateway 依赖端口 (review 流)", () => {
  it("runBatch 后 listQueue(proposed) 返回视图字段", async () => {
    await generalizer.runBatch("batch-1", [
      mkLesson("a", "队列并发丢消息"),
      mkLesson("b", "网关并发竞态"),
    ]);
    const q = generalizer.listQueue("proposed");
    expect(q.length).toBeGreaterThanOrEqual(1);
    const item = q[0]!;
    expect(item.id).toMatch(/^p/);
    expect(item.status).toBe("proposed");
    expect(item.proposal.covers.length).toBe(2);
    expect(typeof item.proposal.confidence).toBe("number");
  });

  it("confirm 后 listQueue 状态变 confirmed, rule 落库带确认", () => {
    const item = generalizer.listQueue("proposed")[0]!;
    const res = generalizer.confirm(item.id, "user:dsh-web");
    expect(res.ok).toBe(true);
    expect(res.ruleId).toBeTruthy();
    const rules = store.query({ kind: "rule" });
    expect(rules.length).toBe(1);
    expect(rules[0]!.confirmedBy).toBe("user:dsh-web");
    expect(generalizer.listQueue("confirmed").length).toBe(1);
  });

  it("memoryQuery 数据面: store.query 可按文本/kind 过滤", () => {
    const all = store.query({});
    expect(all.length).toBeGreaterThanOrEqual(2);
    const lessons = store.query({ kind: "lesson" });
    expect(lessons.length).toBe(2);
    const hit = store.query({ text: "并发" });
    expect(hit.length).toBe(2);
  });
});
