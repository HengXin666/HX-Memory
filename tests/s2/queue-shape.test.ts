// tests/s2/queue-shape.test.ts — 队列行的形状校验 (坏数据不能让网关整体失败)。
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileBackend } from "../../src/storage/file-store.ts";
import { GeneralizerService } from "../../src/generalize/service.ts";

let root: string;
let store: FileBackend;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hxmem-queue-shape-"));
  store = new FileBackend({ root });
});
afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

function writeQueue(lines: string[]) {
  mkdirSync(join(root, "review"), { recursive: true });
  appendFileSync(join(root, "review", "queue.jsonl"), lines.join("\n") + "\n", "utf8");
}

describe("队列行形状", () => {
  it("status 非法 / rule 空白 / 截断的行被跳过; 缺 covers 的行补成空数组 (可用)", () => {
    const g = new GeneralizerService(store, join(root, "review"));
    writeQueue([
      JSON.stringify({ id: "p1", status: "proposed", proposal: { rule: "缺 covers" } }),
      JSON.stringify({ id: "p2", status: "weird", proposal: { rule: "非法状态", covers: [] } }),
      JSON.stringify({ id: "p3", status: "proposed", proposal: { rule: "   ", covers: [] } }),
      '{"id":"p4","status":"proposed"',
    ]);
    const queue = g.listQueue();
    expect(queue.map((p) => p.id)).toEqual(["p1"]);
    expect(queue[0]!.proposal.covers).toEqual([]);
  });

  it("形状不完整的行不会让 confirm 抛 TypeError", async () => {
    const g = new GeneralizerService(store, join(root, "review"));
    const good = g.enqueueProposal({ rule: "好提议" });
    writeQueue([
      JSON.stringify({ id: "broken", status: "proposed", proposal: { rule: "缺 covers" } }),
    ]);
    const res = await g.confirm(good.id, "user:test");
    expect(res.ok).toBe(true);
    expect(store.query({ kind: "rule" })).toHaveLength(1);
  });
});
