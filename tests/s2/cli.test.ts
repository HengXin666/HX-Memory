// tests/s2/cli.test.ts — CLI 是"没有宿主也能用"的兜底入口 (也用于迁移运维)。
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../../src/adapters/codex/cli.ts";
import { FileBackend } from "../../src/storage/file-store.ts";
import { EpisodeStore } from "../../src/storage/episode-store.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hxmem-cli-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("CLI", () => {
  it("没有 --root 时报用法并返回 1", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await main(["stats"])).toBe(1);
    expect(spy.mock.calls.join(" ")).toContain("usage");
    spy.mockRestore();
  });

  it("stats 输出可观测面 (含引擎状态), verify 在一致性正常时返回 0", async () => {
    const store = new FileBackend({ root });
    store.add({
      kind: "lesson",
      content: "CLI 冒烟: 容器并发要设上限",
      source: "test",
      scope: "agent",
      ts: { validAt: "2026-06-01T00:00:00.000Z", assertedAt: "2026-06-01T00:00:00.000Z" },
    });
    store.close();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await main(["stats", "--root", root])).toBe(0);
    expect(log.mock.calls.join("\n")).toContain("lesson");
    log.mockClear();
    expect(await main(["verify", "--root", root])).toBe(0);
    expect(log.mock.calls.join("\n")).toContain('"ok": true');
    log.mockRestore();
  });

  it("rebuild --episodes 从原文重放并给出报告 (T2)", async () => {
    const episodes = new EpisodeStore({ root });
    episodes.append({
      id: "ep-cli",
      session: "s",
      turn: 1,
      role: "user",
      text: "踩坑: 容器并发要显式设上限",
      at: "2026-06-01T00:00:00.000Z",
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await main(["rebuild", "--root", root, "--episodes"])).toBe(0);
    const out = log.mock.calls.join("\n");
    expect(out).toContain('"level": "T2"');
    expect(out).toContain("T2 抽取重建");
    log.mockRestore();
    const store = new FileBackend({ root });
    expect(store.query({ kind: "lesson" }).length).toBe(1);
    store.close();
  });

  it("rebuild (默认 T1) 重建索引后 verify 一致", async () => {
    const store = new FileBackend({ root });
    store.add({
      kind: "fact",
      content: "CLI T1 重建",
      source: "test",
      scope: "agent",
      ts: { validAt: "2026-06-01T00:00:00.000Z", assertedAt: "2026-06-01T00:00:00.000Z" },
    });
    store.close();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await main(["rebuild", "--root", root])).toBe(0);
    expect(log.mock.calls.join("\n")).toContain("T1 索引重建");
    log.mockClear();
    expect(await main(["verify", "--root", root])).toBe(0);
    log.mockRestore();
  });
});
