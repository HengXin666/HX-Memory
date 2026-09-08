// tests/s2/generalizer.test.ts — S2: 推广服务 (聚类→提议→人工闸门确认)。
// 铁律验证: 确认前记忆里无 rule; 确认后 rule 带 confirmedBy + generalizes 关联。
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileBackend } from "../../src/storage/file-store.ts";
import { GeneralizerService } from "../../src/generalize/service.ts";

let root: string;
let store: FileBackend;
let service: GeneralizerService;

function mkLesson(id: string, content: string) {
  return {
    id,
    kind: "lesson" as const,
    content,
    source: "session:t" + id,
    scope: "project" as const,
    ts: { validAt: "2026-09-06T00:00:00.000Z", assertedAt: "2026-09-06T00:00:00.000Z" },
  };
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "hxmem-s2g-"));
  store = new FileBackend({ root });
  service = new GeneralizerService(store, join(root, "review"));
});

afterAll(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

describe("GeneralizerService: 推广 + 人工闸门", () => {
  it("batch with 2 concurrency lessons produces 1 proposed queue item", async () => {
    store.add(mkLesson("a", "后端队列并发, 任务互相覆盖丢失"));
    store.add(mkLesson("b", "批量任务并发写入导致竞态"));
    const proposals = await service.runBatch("run-1", [
      mkLesson("a", "后端队列并发, 任务互相覆盖丢失"),
      mkLesson("b", "批量任务并发写入导致竞态"),
    ]);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.status).toBe("proposed");
    expect(proposals[0]!.proposal.covers.sort()).toEqual(["a", "b"]);
  });

  it("proposal never auto-confirms into a rule", () => {
    const rules = store.query({ kind: "rule" });
    expect(rules).toHaveLength(0);
  });

  it("confirm() gates: rejected/nonexistent id returns error", async () => {
    const bad = await service.confirm("p-does-not-exist", "user:hengxin");
    expect(bad.ok).toBe(false);
    const item = service.listQueue("proposed")[0]!;
    const dup = await service.confirm(item.id, "user:hengxin");
    expect(dup.ok).toBe(true); // 首次确认成功
    const again = await service.confirm(item.id, "user:hengxin");
    expect(again.ok).toBe(false); // 幂等: 已确认不能再确认
  });

  it("confirmed rule carries confirmedBy + generalizes relations", () => {
    const rules = store.query({ kind: "rule" });
    expect(rules).toHaveLength(1);
    const rule = rules[0]!;
    expect(rule.confirmedBy).toBe("user:hengxin");
    expect(rule.confirmedAt).toBeTruthy();
    const covers = store.traverse(rule.id, "generalizes");
    expect(covers.length).toBe(2);
  });

  it("reject() marks queue item rejected, no rule created", async () => {
    const proposals = await service.runBatch("run-2", [mkLesson("c", "部署后忘了加健康检查")]);
    expect(proposals).toHaveLength(1);
    const id = proposals[0]!.id;
    service.reject(id);
    const q = service.listQueue();
    expect(q.find((p) => p.id === id)?.status).toBe("rejected");
    expect(store.query({ kind: "rule" }).length).toBe(1); // 仍是之前那 1 条
  });
});
