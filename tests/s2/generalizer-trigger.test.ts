// tests/s2/generalizer-trigger.test.ts — 推广闭环的触发点与回退回归。
// 坑: runBatch 从来没有生产调用者 → review 队列永远为空 → 跨项目注入没有内容;
// 抽象器抛错会把整批带崩 (注释却声称会回退启发式)。
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileBackend } from "../../src/storage/file-store.ts";
import { GeneralizerService, type Abstractor } from "../../src/generalize/service.ts";

let root: string;
let store: FileBackend;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hxmem-trigger-"));
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
    ts: { validAt: "2026-06-01T00:00:00.000Z", assertedAt: "2026-06-01T00:00:00.000Z" },
  });
}

describe("runRecent (面板/工具的统一触发点)", () => {
  it("从最近的 lesson 聚类产出提议; 重复触发不产生重复提议", async () => {
    lesson("l1", "队列并发丢消息");
    lesson("l2", "网关并发竞态");
    const g = new GeneralizerService(store, join(root, "review"));
    const first = await g.runRecent("panel:1");
    expect(first.length).toBeGreaterThanOrEqual(1);
    expect(g.listQueue("proposed").length).toBe(first.length);
    const second = await g.runRecent("panel:2");
    expect(second).toEqual([]); // 已覆盖的实例被跳过
  });

  it("没有候选时返回空数组 (不抛错)", async () => {
    const g = new GeneralizerService(store, join(root, "review"));
    await expect(g.runRecent("panel:empty")).resolves.toEqual([]);
  });
});

describe("抽象器失败必须回退, 不能带崩整批", () => {
  it("abstractor 抛错 → 启发式提议仍然产出", async () => {
    lesson("l3", "部署后忘了加健康检查");
    lesson("l4", "部署回滚没留版本号");
    const failing: Abstractor = {
      async abstract() {
        throw new Error("agents service unavailable");
      },
    };
    const errors: string[] = [];
    const g = new GeneralizerService(store, join(root, "review"), failing, {
      onAbstractError: (e, c) => errors.push(c.theme + ":" + String(e)),
    });
    const proposals = await g.runBatch("run-fail", [store.get("l3")!, store.get("l4")!]);
    expect(proposals.length).toBeGreaterThanOrEqual(1);
    expect(proposals[0]!.proposal.rule.length).toBeGreaterThan(0);
    expect(errors.length).toBeGreaterThanOrEqual(1);
  });

  it("abstractor 成功时用它的规则与置信度", async () => {
    lesson("l5", "并发写同一张表要加锁");
    const ok: Abstractor = {
      async abstract() {
        return { rule: "写共享表必须显式加锁", confidence: 0.9 };
      },
    };
    const g = new GeneralizerService(store, join(root, "review"), ok);
    const [p] = await g.runBatch("run-ok", [store.get("l5")!]);
    expect(p!.proposal.rule).toBe("写共享表必须显式加锁");
    expect(p!.proposal.confidence).toBe(0.9);
  });
});

describe("enqueueProposal (memory_rule_propose 工具)", () => {
  it("提议进队列且状态为 proposed, 确认后成为规则", async () => {
    const g = new GeneralizerService(store, join(root, "review"));
    const p = g.enqueueProposal({ rule: "所有容器都要显式设计并发上限", confidence: 2 });
    expect(p.status).toBe("proposed");
    expect(p.proposal.confidence).toBe(1); // 夹到 0-1
    const res = await g.confirm(p.id, "user:dsh-web");
    expect(res.ok).toBe(true);
    const rules = store.query({ kind: "rule" });
    expect(rules).toHaveLength(1);
    expect(rules[0]!.confirmedBy).toBe("user:dsh-web");
  });

  it("空规则被拒绝", () => {
    const g = new GeneralizerService(store, join(root, "review"));
    expect(() => g.enqueueProposal({ rule: "   " })).toThrow(/must not be empty/);
  });
});
