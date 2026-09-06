// self-proof: 泛化链路 — 具体事故 → 聚类 → 提议 → 人工确认成跨项目 rule。
import { it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileBackend } from "../../src/storage/file-store.ts";
import { CapturePipeline } from "../../src/capture/pipeline.ts";
import { GeneralizerService } from "../../src/generalize/service.ts";

it("self-proof: 并发事故 → 跨项目规则 (人工闸门)", async () => {
  const root = mkdtempSync(join(tmpdir(), "hxmem-gen-"));
  const store = new FileBackend({ root });
  const pipe = new CapturePipeline(store);
  const g = new GeneralizerService(store, join(root, "review"));

  // 1) 三个不同项目的并发事故被捕获为 lesson
  for (const [proj, text] of [
    ["backend-queue", "后端队列并发 bug: 消费者互相覆盖任务, 丢了消息"],
    ["api-gateway", "网关并发写入导致竞态, 请求丢失"],
    ["batch-job", "批处理并发跑挂了, 任务重复执行"],
  ]) {
    pipe.run({ text: "踩坑: " + text, session: "s" + proj, project: proj });
  }
  const lessons = store.query({ kind: "lesson" });
  expect(lessons.length).toBe(3);

  // 2) 批量推广 → 一个 concurrency 提议进队列 (永不自动成规则)
  const proposals = await g.runBatch("self-proof-1", lessons);
  expect(proposals.length).toBeGreaterThanOrEqual(1);
  expect(store.query({ kind: "rule" }).length).toBe(0); // 提议后仍无 rule

  // 3) 人工确认 → 成为全局规则, 带确认记录 + generalizes 关联回实例
  const pid = proposals.find((p) => p.proposal.covers.length >= 3)!.id;
  const res = g.confirm(pid, "user:hengxin");
  expect(res.ok).toBe(true);
  const rules = store.query({ kind: "rule" });
  expect(rules.length).toBe(1);
  const rule = rules[0]!;
  expect(rule.scope).toBe("global");
  expect(rule.confirmedBy).toBe("user:hengxin");
  // generalizes 指向 3 条实例
  const covers = store.traverse(rule.id, "generalizes");
  expect(covers.length).toBe(3);

  store.close();
  rmSync(root, { recursive: true, force: true });
});
