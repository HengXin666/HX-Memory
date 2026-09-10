// tests/s2/consolidation.test.ts — 衰减/过期整合 (S3 的确定性部分)。
//
// 三条安全底线必须被钉住: 只碰短命种类 / 命中过的永不过期 / 永不删除 (可复活)。
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileBackend } from "../../src/storage/file-store.ts";
import { ConsolidationService } from "../../src/app/consolidate.ts";
import { HybridRetriever } from "../../src/retrieval/hybrid.ts";
import { MemoryFacade } from "../../src/app/facade.ts";

let root: string;
let store: FileBackend;
const NOW = "2026-06-01T00:00:00.000Z";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hxmem-consolidate-"));
  store = new FileBackend({ root });
});
afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

const add = (over: Record<string, unknown> = {}) =>
  store.add({
    kind: "event",
    content: "一次性事件",
    source: "test",
    scope: "agent",
    ts: { validAt: "2026-01-01T00:00:00.000Z", assertedAt: "2026-01-01T00:00:00.000Z" },
    ...over,
  } as never);

const service = () => new ConsolidationService({ store, now: () => NOW });

describe("整合: 衰减过期", () => {
  it("久远且从未命中的 event → expired (可逆, 真相仍在)", async () => {
    const e = add({ id: "old-event" });
    const report = await service().run();
    expect(report.expiring.map((x) => x.id)).toEqual(["old-event"]);
    expect(report.applied).toBe(true);
    const after = store.get(e.id);
    expect(after?.status).toBe("expired");
    expect(after?.content).toBe("一次性事件");
    // 检索默认不返回, 但显式查询仍在
    expect(new HybridRetriever(store).retrieveSync({ text: "一次性事件" }).hits).toEqual([]);
    expect(store.query({ includeShadow: true }).some((x) => x.id === e.id)).toBe(true);
  });

  it("新近的 event 不过期; 旧的 lesson 永不过期 (只降权不消失)", async () => {
    add({
      id: "new-event",
      ts: { validAt: "2026-05-30T00:00:00.000Z", assertedAt: "2026-05-30T00:00:00.000Z" },
    });
    add({
      id: "old-lesson",
      kind: "lesson",
      content: "容器并发要显式设上限",
      ts: { validAt: "2020-01-01T00:00:00.000Z", assertedAt: "2020-01-01T00:00:00.000Z" },
    });
    const report = await service().run();
    expect(report.expiring).toEqual([]);
    expect(report.protectedByKind).toBe(1);
    expect(store.get("old-lesson")?.status).toBe("active");
  });

  it("命中过的 (reinforcement>0) 不受衰减影响 —— 强化即生命", async () => {
    add({ id: "hit", reinforcement: 3, lastHitAt: "2026-01-02T00:00:00.000Z" });
    const report = await service().run();
    expect(report.expiring).toEqual([]);
    expect(report.protectedByReinforcement).toBe(1);
  });

  it("显式 TTL 到期优先于衰减计算", async () => {
    add({
      id: "ttl",
      expiresAt: "2026-05-01T00:00:00.000Z",
      ts: { validAt: "2026-05-29T00:00:00.000Z", assertedAt: "2026-05-29T00:00:00.000Z" },
    });
    const report = await service().run();
    expect(report.expiring[0]).toMatchObject({ id: "ttl", reason: "ttl" });
  });

  it("rule 永不被自动过期 (人工闸门是产品承诺)", async () => {
    store.add({
      id: "rule-1",
      kind: "rule",
      content: "涉及容器并发时先检查并发策略",
      source: "review:confirm",
      scope: "global",
      ts: { validAt: "2020-01-01T00:00:00.000Z", assertedAt: "2020-01-01T00:00:00.000Z" },
      confirmedBy: "hx",
      confirmedAt: "2020-01-01T00:00:00.000Z",
    });
    const report = await service().run({ expirableKinds: ["event", "context", "rule"] });
    expect(report.expiring).toEqual([]);
    expect(store.get("rule-1")?.status).toBe("active");
  });

  it("干跑只报告不写盘", async () => {
    add({ id: "dry" });
    const report = await service().run({ dryRun: true });
    expect(report.expiring.map((x) => x.id)).toEqual(["dry"]);
    expect(report.applied).toBe(false);
    expect(store.get("dry")?.status).toBe("active");
  });

  it("幂等: 重复跑不会再处理已过期的条目", async () => {
    add({ id: "once" });
    const first = await service().run();
    const second = await service().run();
    expect(first.expiring.length).toBe(1);
    expect(second.expiring.length).toBe(0);
  });

  it("revive 可以把过期条目拉回 active (遗忘是可逆的)", async () => {
    const e = add({ id: "back" });
    await service().run();
    expect(store.get(e.id)?.status).toBe("expired");
    await service().revive(e.id);
    expect(store.get(e.id)?.status).toBe("active");
  });

  it("复活后能重新被召回 (端到端可逆)", async () => {
    const e = add({ id: "revive-me", content: "容器并发策略缺失" });
    const facade = new MemoryFacade({ store, retriever: new HybridRetriever(store) });
    await service().run();
    expect(facade.recall({ text: "容器并发" }).hits).toEqual([]);
    await service().revive(e.id);
    expect(facade.recall({ text: "容器并发" }).hits.length).toBe(1);
  });
});
