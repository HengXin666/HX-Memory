// tests/s2/codex-adapter.test.ts — S2: Codex adapter 接真实存储, 验证 AGENTS.md 同步。
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileBackend } from "../../src/storage/file-store.ts";
import { CodexAdapter } from "../../src/adapters/codex/adapter.ts";

let root: string;
let repo: string;
let store: FileBackend;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "hxmem-cx-"));
  repo = mkdtempSync(join(tmpdir(), "hxmem-cxrepo-"));
  store = new FileBackend({ root });
  // 一条已确认的全局规则
  store.add({
    id: "rx",
    kind: "rule",
    content: "所有容器都要显式设计并发上限",
    source: "generalizer:test",
    scope: "global",
    ts: { validAt: "2026-01-01T00:00:00.000Z", assertedAt: "2026-01-01T00:00:00.000Z" },
    confirmedBy: "u",
    confirmedAt: "t",
  });
});

afterAll(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

describe("CodexAdapter: AGENTS.md 同步", () => {
  it("onSessionStart writes rules into AGENTS.md", async () => {
    const adapter = new CodexAdapter({ store, repoRoot: repo, language: "zh" });
    const res = (await adapter.onSessionStart({ id: "cli" })) as {
      updated: boolean;
      rules: number;
    };
    expect(res.updated).toBe(true);
    expect(res.rules).toBe(1);
    const md = readFileSync(join(repo, "AGENTS.md"), "utf8");
    expect(md).toContain("所有容器都要显式设计并发上限");
    expect(md).toContain("hx-memory:rules:start");
  });

  it("second sync is idempotent (no rewrite)", async () => {
    const adapter = new CodexAdapter({ store, repoRoot: repo, language: "zh" });
    const res = (await adapter.onSessionStart({ id: "cli" })) as { updated: boolean };
    expect(res.updated).toBe(false);
  });

  it("onPreStep returns recall for matching text", async () => {
    const adapter = new CodexAdapter({ store, repoRoot: repo });
    const recall = await adapter.onPreStep({ text: "容器并发策略", at: "t" });
    expect(recall).not.toBeNull();
    expect(recall!.entries.some((e) => e.content.includes("并发上限"))).toBe(true);
  });
});
