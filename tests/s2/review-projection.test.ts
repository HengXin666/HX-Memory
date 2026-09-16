// tests/s2/review-projection.test.ts — 人审面的两条投影 + gateway 出口 (人审必须看得见依据)。
//
// 为什么钉在这里: 提议行只回一个 covers 计数时, "该不该确认"无法回答 —— 判断依据是被
// 概括的那几条原文。这条契约跨三处 (队列行 → 投影 → 面板), 前两处是纯逻辑, 在这里断言;
// 面板渲染由 tsc -p tsconfig.client.json + build:client 门禁覆盖。
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemoryEntry } from "../../src/kernel/types.ts";
import { projectFlagged, toReviewView } from "../../src/adapters/dsh/gateway-review.ts";
import { HxMemoryGateway } from "../../src/adapters/dsh/gateway.ts";
import { GeneralizerService, type QueuedProposal } from "../../src/generalize/service.ts";
import { FileBackend } from "../../src/storage/file-store.ts";

function entry(id: string, patch: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id,
    kind: "lesson",
    content: "内容 " + id,
    source: "session:test",
    scope: "project",
    project: "HX-Memory",
    ts: { validAt: "2026-09-13T00:00:00.000Z", assertedAt: "2026-09-13T00:00:00.000Z" },
    ...patch,
  };
}

function queued(id: string, patch: Partial<QueuedProposal["proposal"]> = {}): QueuedProposal {
  return {
    id,
    status: "proposed",
    sourceRun: "panel:test",
    proposal: {
      rule: "规则 " + id,
      covers: ["m1", "m2"],
      confidence: 0.7,
      suggestedAction: "confirm",
      generatedAt: "2026-09-13T00:00:00.000Z",
      ...patch,
    },
  };
}

describe("reviewQueue 投影", () => {
  it("covers 给的是**实例 id 列表**, 不是计数 (人审要据此取原文)", () => {
    const v = toReviewView(queued("p1"));
    expect(v.covers).toEqual(["m1", "m2"]);
  });

  it("id 列表是副本: 改视图不会回写队列行", () => {
    const p = queued("p1");
    const v = toReviewView(p);
    v.covers.push("m3");
    expect(p.proposal.covers).toEqual(["m1", "m2"]);
  });

  it("drafted 缺省为 false (老队列行没这个字段 → 不当成草稿)", () => {
    expect(toReviewView(queued("p1")).drafted).toBe(false);
    expect(toReviewView(queued("p2", { drafted: true })).drafted).toBe(true);
  });

  it("suggestedAction 原样透出 (展示层据此区分确认/改写)", () => {
    expect(toReviewView(queued("p1", { suggestedAction: "rewrite" })).suggestedAction).toBe(
      "rewrite",
    );
  });
});

describe("被标注记忆的投影", () => {
  it("只留坏评 > 0 的条目, 按坏评总数倒序", () => {
    const rows = [
      entry("m1", { feedback: { irrelevant: 1, wrong: 0 }, reinforcement: 3 }),
      entry("m2", { feedback: { irrelevant: 0, wrong: 0 } }),
      entry("m3", { feedback: { irrelevant: 2, wrong: 3 }, reinforcement: 10 }),
    ];
    expect(projectFlagged(rows).map((r) => r.id)).toEqual(["m3", "m1"]);
  });

  it("坏评明细与曝光一起给 (只有总数时无法解释为什么被降权)", () => {
    const v = projectFlagged([
      entry("m1", { feedback: { irrelevant: 2, wrong: 1 }, reinforcement: 8 }),
    ])[0]!;
    expect(v.irrelevant).toBe(2);
    expect(v.wrong).toBe(1);
    expect(v.exposure).toBe(8);
    expect(v.quality).toBeGreaterThan(0);
    expect(v.quality).toBeLessThanOrEqual(1);
  });

  it("limit 有界 (0/负数不会退化成空或全量)", () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      entry("m" + i, { feedback: { irrelevant: 1, wrong: 0 } }),
    );
    expect(projectFlagged(rows, 2)).toHaveLength(2);
    expect(projectFlagged(rows, 0)).toHaveLength(1);
  });

  it("content 截断到 200 字 (列表是索引, 不是转录)", () => {
    const v = projectFlagged([
      entry("m1", { content: "x".repeat(400), feedback: { irrelevant: 1, wrong: 0 } }),
    ])[0]!;
    expect(v.content).toHaveLength(200);
  });
});

describe("草稿标记 (drafted) 的落盘与回读", () => {
  it("无 AI 抽象器时产出的提议带 drafted=true, 且能穿过队列文件回读", async () => {
    const root = mkdtempSync(join(tmpdir(), "hxmem-drafted-"));
    const store = new FileBackend({ root });
    try {
      const g = new GeneralizerService(store, join(root, "review"));
      await g.runBatch("panel:test", [
        { ...entry("m1", { kind: "lesson" }), content: "并发写同一个文件会丢消息" },
        { ...entry("m2", { kind: "lesson" }), content: "并发追加要按 turn 顺序落盘" },
      ] as MemoryEntry[]);
      const queuedRow = g.listQueue("proposed")[0]!;
      // 走的是启发式兜底 (没有 abstractor): 文本只是占位提示, 必须能被标成草稿。
      expect(queuedRow.proposal.drafted).toBe(true);
      expect(queuedRow.proposal.suggestedAction).toBe("rewrite");
      // 回读路径 (JSONL → parseProposalLine) 也要保留它, 且面板视图如实透出。
      expect(toReviewView(queuedRow).drafted).toBe(true);
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("有 AI 抽象器时不打草稿标记 (文本是真抽象出来的规则)", async () => {
    const root = mkdtempSync(join(tmpdir(), "hxmem-drafted-llm-"));
    const store = new FileBackend({ root });
    try {
      const g = new GeneralizerService(store, join(root, "review"), {
        abstract: async () => ({ rule: "并发写入必须串行化到单一写者", confidence: 0.9 }),
      });
      await g.runBatch("panel:test", [
        { ...entry("m1", { kind: "lesson" }), content: "并发写同一个文件会丢消息" },
        { ...entry("m2", { kind: "lesson" }), content: "并发追加要按 turn 顺序落盘" },
      ] as MemoryEntry[]);
      const row = g.listQueue("proposed")[0]!;
      expect(row.proposal.drafted).toBeUndefined();
      expect(toReviewView(row).drafted).toBe(false);
      expect(row.proposal.suggestedAction).toBe("confirm");
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/** 只用到 deps 的出口 → 用最小桩 (与 tests/s3/dsh-adapter.test.ts 同一手法)。 */
function gatewayWith(store: { get(id: string): MemoryEntry | null }, queue: QueuedProposal[]) {
  const gw = Object.create(HxMemoryGateway.prototype) as {
    deps: unknown;
    reviewQueue(status: string): unknown[];
    entriesByIds(ids: string[]): Array<{ id: string; content: string; kind: string }>;
  };
  gw.deps = {
    store: { query: () => [], get: store.get, remove: () => {}, recent: () => [] },
    generalizer: {
      listQueue: () => queue,
      confirm: async () => ({ ok: true }),
      reject: () => {},
      runBatch: async () => ({}),
      runRecent: async () => ({}),
      enqueueProposal: () => ({ id: "p" }),
      status: () => ({ abstractor: false, queue: { proposed: 0, confirmed: 0, rejected: 0 } }),
    },
  };
  return gw;
}

describe("gateway 人审出口", () => {
  it("reviewQueue 把队列行投影成面板视图 (含 covers id 与 drafted)", () => {
    const gw = gatewayWith({ get: () => null }, [queued("p1"), queued("p2", { drafted: true })]);
    const views = gw.reviewQueue("proposed") as Array<{ id: string; covers: string[]; drafted: boolean }>;
    expect(views.map((v) => v.id)).toEqual(["p1", "p2"]);
    expect(views[0]!.covers).toEqual(["m1", "m2"]);
    expect(views[1]!.drafted).toBe(true);
  });

  it("entriesByIds 取回被 covers 引用的原文", () => {
    const store = new Map([
      ["m1", entry("m1", { content: "并发写同一个文件会丢消息" })],
      ["m2", entry("m2", { content: "队列要按 turn 顺序落盘" })],
    ]);
    const gw = gatewayWith({ get: (id) => store.get(id) ?? null }, []);
    const rows = gw.entriesByIds(["m1", "m2"]);
    expect(rows.map((r) => r.content)).toEqual(["并发写同一个文件会丢消息", "队列要按 turn 顺序落盘"]);
  });

  it("entriesByIds 跳过已不存在的 id, 不因为一条失效就整块失败", () => {
    const gw = gatewayWith({ get: (id) => (id === "m1" ? entry("m1") : null) }, []);
    expect(gw.entriesByIds(["m1", "gone", "m1-lost"]).map((r) => r.id)).toEqual(["m1"]);
  });

  it("entriesByIds 忽略非字符串/空 id (面板传来的参数不可信)", () => {
    const gw = gatewayWith({ get: (id) => (id === "m1" ? entry("m1") : null) }, []);
    const rows = gw.entriesByIds(["m1", "", null as unknown as string, "m1"]);
    expect(rows.map((r) => r.id)).toEqual(["m1"]);
  });
});
