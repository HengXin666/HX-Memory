import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { workspaceBankId } from "../../src/external/canonical.ts";
import { createExternalHost } from "../../src/external/host.ts";
import { lexicalKnowledgeEngine, lexicalMemoryEngine } from "../../src/external/lexical.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.length = 0;
});

describe("外置宿主性能", () => {
  it("词面投影上的保留、召回、挫折、文档和重放都有预算", async () => {
    const root = mkdtempSync(join(tmpdir(), "hx-ext-perf-"));
    roots.push(root);
    const bank = workspaceBankId("perf");
    const other = workspaceBankId("other");
    const host = createExternalHost({
      root,
      memory: lexicalMemoryEngine(),
      knowledge: lexicalKnowledgeEngine(),
    });
    const n = 800;
    const retainStart = now();
    for (let i = 0; i < n; i++) {
      await host.retain({
        bankId: i === 17 ? other : bank,
        kind: i % 5 === 0 ? "decision" : "episode",
        text: "条目 " + i + " 关于 cache-ttl-" + (i % 40) + " 与队列上限",
        entities: ["cache"],
      });
    }
    const retainMs = now() - retainStart;

    const cardStart = now();
    const card = await host.onSessionStart(bank);
    const sessionCardMs = now() - cardStart;

    const recallN = 200;
    const hitStart = now();
    let found = 0;
    for (let i = 0; i < recallN; i++) {
      const views = await host.recall({ bankId: bank, query: "cache-ttl-" + (i % 40), limit: 5 });
      if (views.some((view) => view.record.text.includes("cache-ttl-" + (i % 40)))) found += 1;
      expect(views.some((view) => view.record.bankId === other)).toBe(false);
    }
    const recallHitMs = now() - hitStart;

    const missStart = now();
    for (let i = 0; i < recallN; i++) {
      const views = await host.recall({ bankId: bank, query: "zzxq-nomatch-" + i, limit: 5 });
      expect(views.length).toBe(0);
    }
    const recallMissMs = now() - missStart;

    const frustrationN = 40;
    const frStart = now();
    for (let i = 0; i < frustrationN; i++) {
      const outcome = await host.onUserMessage({
        bankId: bank,
        text: "你这个傻逼把 cache 写错了",
        context: "上一轮改了 cache-ttl 文件",
      });
      expect(outcome.fired).toBe(true);
      expect(outcome.inject ?? "").not.toMatch(/傻逼/);
    }
    const frustrationMs = now() - frStart;

    const docs = 80;
    const syncStart = now();
    await host.syncDocs(
      bank,
      Array.from({ length: docs }, (_, i) => ({
        id: "doc" + i,
        path: "docs/cache-" + i + ".md",
        markdown: "cache-ttl 说明 " + i,
        assets: [{ path: "img/cache-" + i + ".png", caption: "caption-" + i + " 示意图" }],
        updatedAt: "2026-10-24T00:00:00.000Z",
      })),
    );
    const knowledgeSyncMs = now() - syncStart;
    const searchStart = now();
    let docHits = 0;
    for (let i = 0; i < docs; i++) {
      const hits = await host.searchKnowledge(bank, "caption-" + i, 3);
      if (hits.some((hit) => hit.path.endsWith(i + ".md"))) docHits += 1;
    }
    const knowledgeSearchMs = now() - searchStart;

    const next = lexicalMemoryEngine();
    const reindexStart = now();
    await host.swapMemory(next);
    const reindexMs = now() - reindexStart;
    const after = await host.recall({ bankId: bank, query: "cache-ttl-3", limit: 5 });

    const report = {
      memories: n,
      retainMs: round(retainMs),
      retainPerOpMs: round(retainMs / n),
      sessionCardMs: round(sessionCardMs),
      recallN,
      recallHitMs: round(recallHitMs),
      recallHitPerOpMs: round(recallHitMs / recallN),
      recallMissMs: round(recallMissMs),
      recallMissPerOpMs: round(recallMissMs / recallN),
      frustrationN,
      frustrationMs: round(frustrationMs),
      frustrationPerOpMs: round(frustrationMs / frustrationN),
      docs,
      knowledgeSyncMs: round(knowledgeSyncMs),
      knowledgeSearchMs: round(knowledgeSearchMs),
      knowledgeSearchPerOpMs: round(knowledgeSearchMs / docs),
      reindexMs: round(reindexMs),
    };
    console.log("EXTERNAL_PERF " + JSON.stringify(report));

    expect(found).toBe(recallN);
    expect(docHits).toBe(docs);
    expect(after.length).toBeGreaterThan(0);
    expect(card.ids.length).toBeGreaterThan(0);
    expect(report.recallHitPerOpMs).toBeLessThan(40);
    expect(report.recallMissPerOpMs).toBeLessThan(20);
    expect(report.knowledgeSearchPerOpMs).toBeLessThan(20);
    expect(report.frustrationPerOpMs).toBeLessThan(50);
    expect(report.retainPerOpMs).toBeLessThan(30);
    expect(report.reindexMs).toBeLessThan(8000);
  }, 20_000);
});

function now(): number {
  return Number(process.hrtime.bigint()) / 1e6;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
