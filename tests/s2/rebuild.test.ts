// tests/s2/rebuild.test.ts — 分级重建的契约 (T1 索引 / T2 抽取)。
//
// 这是"全量数据重建"这句话的证据: 换抽取器要能重放, 重放要幂等, 旧抽取结果不能丢只能被取代。
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileBackend } from "../../src/storage/file-store.ts";
import { EpisodeStore } from "../../src/storage/episode-store.ts";
import { CapturePipeline } from "../../src/capture/pipeline.ts";
import { HxMemoryRuntime } from "../../src/adapters/dsh/runtime.ts";
import { RebuildService, captureExtractor } from "../../src/app/rebuild.ts";
import type { Episode, MemoryEntryInput } from "../../src/kernel/types.ts";

let root: string;
let store: FileBackend;
let episodes: EpisodeStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hxmem-rebuild-"));
  store = new FileBackend({ root });
  episodes = new EpisodeStore({ root });
});
afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

async function turn(runtime: HxMemoryRuntime, session: { id: string }, text: string) {
  await runtime.capture(session, { type: "turn/start", data: {} });
  await runtime.capture(session, {
    type: "user/message",
    data: { source: { kind: "user" }, content: [{ type: "text", text }] },
  });
  await runtime.capture(session, { type: "turn/end", data: { reason: { kind: "completed" } } });
}

async function seed(texts: string[]): Promise<void> {
  const runtime = new HxMemoryRuntime(
    new CapturePipeline(store),
    () => ({ autoCapture: true, autoMemoryInterval: 1 }),
    { episodes, surface: "dsh" },
  );
  const session = { id: "s1" };
  runtime.onSessionStart(session);
  for (const text of texts) await turn(runtime, session, text);
}

describe("T2 抽取重建", () => {
  it("同一抽取器重放是幂等的 (不产生重复记忆)", async () => {
    await seed(["踩坑: 容器并发要显式设上限", "决定: 采用 pnpm 作为包管理器"]);
    const before = store.query({}).length;
    const service = new RebuildService({ store, episodes });
    const report = await service.rebuildFromEpisodes();
    expect(report.scanned).toBe(2);
    expect(report.created).toBe(0);
    expect(report.unchanged).toBeGreaterThan(0);
    expect(report.superseded).toBe(0);
    expect(store.query({}).length).toBe(before);
  });

  it("换了抽取器: 新结果落盘, 旧结果被 supersede (保留可查, 不删除)", async () => {
    await seed(["踩坑: 容器并发要显式设上限"]);
    const oldEntry = store.query({}).find((e) => e.kind === "lesson");
    expect(oldEntry).toBeDefined();

    // 模拟"升级后的抽取器": 对同一 episode 产出不同内容
    const upgraded = {
      extract(episode: Episode): MemoryEntryInput[] {
        return [
          {
            kind: "lesson" as const,
            content: "升级版抽取: " + episode.text,
            source: "session:" + episode.session,
            scope: "agent" as const,
            ts: { validAt: episode.at, assertedAt: episode.at },
          },
        ];
      },
    };
    const service = new RebuildService({ store, episodes, extractor: upgraded });
    const report = await service.rebuildFromEpisodes();
    expect(report.created).toBe(1);
    expect(report.superseded).toBe(1);
    const superseded = store.get(oldEntry!.id);
    expect(superseded?.status).toBe("superseded");
    expect(superseded?.relations?.some((r) => r.type === "supersededBy")).toBe(true);
    // 旧条目仍然可查 (历史没有被删), 新条目在
    expect(store.all().length).toBe(2);
  });

  it("since 限定只重放新 episode (增量重建)", async () => {
    episodes.append({
      id: "ep-old",
      session: "s",
      turn: 1,
      role: "user",
      text: "旧的踩坑记录",
      at: "2026-01-01T00:00:00.000Z",
    });
    episodes.append({
      id: "ep-new",
      session: "s",
      turn: 2,
      role: "user",
      text: "新的踩坑记录",
      at: "2026-06-01T00:00:00.000Z",
    });
    const service = new RebuildService({ store, episodes });
    const report = await service.rebuildFromEpisodes({ since: "2026-05-01T00:00:00.000Z" });
    expect(report.scanned).toBe(1);
    expect(store.all()[0]?.derivedFrom).toEqual(["ep-new"]);
  });

  it("抽取失败只记错误, 不中断整批 (重建要能跑完并给报告)", async () => {
    episodes.append({
      id: "ep-1",
      session: "s",
      turn: 1,
      role: "user",
      text: "第一条",
      at: "2026-06-01T00:00:00.000Z",
    });
    episodes.append({
      id: "ep-2",
      session: "s",
      turn: 2,
      role: "user",
      text: "第二条踩坑记录",
      at: "2026-06-01T00:00:01.000Z",
    });
    const flaky = {
      extract(episode: Episode): MemoryEntryInput[] {
        if (episode.id === "ep-1") throw new Error("boom");
        return captureExtractor().extract(episode) as MemoryEntryInput[];
      },
    };
    const report = await new RebuildService({
      store,
      episodes,
      extractor: flaky,
    }).rebuildFromEpisodes();
    expect(report.errors.length).toBe(1);
    expect(report.created).toBe(1);
  });
});

describe("T1 索引重建与自检", () => {
  it("引擎自述身份 (schemaVersion) 与重建能力", () => {
    expect(store.schemaVersion).toMatch(/^format\d+\+tokenizer\d+$/);
    expect(typeof store.rebuildFromTruth).toBe("function");
  });

  it("rebuildIndex 从真相重建, verify 全绿", async () => {
    await seed(["踩坑: 容器并发要显式设上限", "决定: 采用 pnpm"]);
    const service = new RebuildService({ store, episodes });
    const report = await service.rebuildIndex();
    expect(report.errors).toEqual([]);
    expect(report.created).toBeGreaterThan(0);
    const verify = await service.verify();
    expect(verify.ok).toBe(true);
    expect(verify.truth).toBe(verify.index);
    expect(verify.fullText).toBe(verify.index);
  });

  it("索引被外力破坏时 verify 会报出漂移 (而不是假装没事)", async () => {
    await seed(["踩坑: 容器并发要显式设上限"]);
    // 直接删掉索引行, 模拟"索引坏了但真相还在"
    const raw = store as unknown as { db: { exec(sql: string): void } };
    raw.db.exec("DELETE FROM memories");
    const verify = await store.verify();
    expect(verify.ok).toBe(false);
    expect(verify.problems.some((p) => p.includes("mismatch"))).toBe(true);
  });
});
