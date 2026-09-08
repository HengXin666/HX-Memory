// tests/s2/generalizer-hardening.test.ts — 推广服务的容错与语义回归。
//   1. 抽象器返回空规则/NaN 置信度 → 回退启发式 (否则会被确认成一条空 rule);
//   2. 队列文件有一行坏数据 → 面板/工具仍可用 (跳过坏行, 不抛错);
//   3. 驳回是"这次不推广", 不是"永远不再提" → 驳回后可以重新提议。
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileBackend } from "../../src/storage/file-store.ts";
import { GeneralizerService, type Abstractor } from "../../src/generalize/service.ts";

let root: string;
let store: FileBackend;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hxmem-gen-hard-"));
  store = new FileBackend({ root });
});
afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

function lesson(id: string, content: string) {
  return store.add({
    id,
    kind: "lesson" as const,
    content,
    source: "s:" + id,
    scope: "project" as const,
    project: "api",
    ts: { validAt: "2026-08-01T00:00:00.000Z", assertedAt: "2026-08-01T00:00:00.000Z" },
  });
}

describe("抽象器输出校验", () => {
  it("空规则 → 回退启发式, 不产出空提议", async () => {
    lesson("l1", "并发写同一张表要加锁");
    const bad: Abstractor = {
      async abstract() {
        return { rule: "   ", confidence: 0.9 };
      },
    };
    const errors: unknown[] = [];
    const g = new GeneralizerService(store, join(root, "review"), bad, {
      onAbstractError: (e) => errors.push(e),
    });
    const [p] = await g.runBatch("run", [store.get("l1")!]);
    expect(p!.proposal.rule.trim().length).toBeGreaterThan(0);
    expect(errors.length).toBe(1);
  });

  it("NaN 置信度 → 回退启发式 (置信度必须是有限数)", async () => {
    lesson("l2", "部署后忘了加健康检查");
    const bad: Abstractor = {
      async abstract() {
        return { rule: "一条规则", confidence: Number.NaN };
      },
    };
    const g = new GeneralizerService(store, join(root, "review"), bad);
    const [p] = await g.runBatch("run", [store.get("l2")!]);
    expect(Number.isFinite(p!.proposal.confidence)).toBe(true);
  });

  it("合法输出被保留 (含置信度 clamp)", async () => {
    lesson("l3", "接口必须幂等");
    const good: Abstractor = {
      async abstract() {
        return { rule: "接口必须幂等", confidence: 5 };
      },
    };
    const g = new GeneralizerService(store, join(root, "review"), good);
    const [p] = await g.runBatch("run", [store.get("l3")!]);
    expect(p!.proposal.rule).toBe("接口必须幂等");
    expect(p!.proposal.confidence).toBe(1);
  });
});

describe("队列容错", () => {
  it("坏行被跳过, 其余提议仍可读/可确认", async () => {
    lesson("l4", "坏行容错");
    const g = new GeneralizerService(store, join(root, "review"));
    const good = g.enqueueProposal({ rule: "好提议" });
    appendFileSync(join(root, "review", "queue.jsonl"), '{"id":"broken"\n', "utf8");
    expect(g.listQueue().map((p) => p.id)).toContain(good.id);
    const res = await g.confirm(good.id, "user:test");
    expect(res.ok).toBe(true);
    // 坏行仍在文件里 (人工可修), 不会被静默删除
    expect(g.listQueue().length).toBe(1);
  });
});

describe("驳回语义", () => {
  it("驳回后可以重新提议 (不是永久抑制)", async () => {
    lesson("l5", "队列并发丢消息");
    lesson("l6", "网关并发竞态");
    const g = new GeneralizerService(store, join(root, "review"));
    const first = await g.runRecent("panel:1");
    expect(first.length).toBeGreaterThanOrEqual(1);
    for (const p of first) g.reject(p.id);
    const second = await g.runRecent("panel:2");
    expect(second.length).toBeGreaterThanOrEqual(1);
  });
});
