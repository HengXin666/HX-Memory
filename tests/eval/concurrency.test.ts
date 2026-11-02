// tests/eval/concurrency.test.ts — P0 (PLAN.md J1.2 / EVAL.md M5) 的回归测试。
// 必须用真实子进程: 同进程内的并发测不出跨进程丢更新与写坏 (REVIEW.md D1 / D17)。
import { describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CanonicalStore } from "../../src/external/store.ts";
import { acquireFileLock } from "../../src/storage/file-lock.ts";
import { scanTruth } from "../../src/storage/truth-scan.ts";
import { FileBackend } from "../../src/storage/file-store.ts";

const REPO = join(import.meta.dirname, "../..");
const NODE_ARGS = ["--experimental-strip-types", "--no-warnings"];

function record(id: string) {
  return {
    id,
    bankId: "ws_t",
    kind: "decision" as const,
    text: "写入 " + id,
    entities: [],
    supersedes: [],
    status: "active" as const,
    createdAt: new Date().toISOString(),
    indexState: "pending" as const,
  };
}

/** 无限写入的子进程 (给"中途被杀"用)。 */
const ENDLESS = `
const [target, root] = process.argv.slice(2);
const at = "2026-09-01T00:00:00.000Z";
if (target === "canonical") {
  const { CanonicalStore } = await import("REPO/src/external/store.ts");
  const store = new CanonicalStore(root);
  for (let i = 0; ; i++) store.saveMemory({ id: "k_" + i, bankId: "ws_t", kind: "decision", text: "x".repeat(200) + i,
    entities: [], supersedes: [], status: "active", createdAt: at, indexState: "pending" });
} else {
  const { FileBackend } = await import("REPO/src/storage/file-store.ts");
  const store = new FileBackend({ root });
  for (let i = 0; ; i++) store.add({ id: "k-" + i, kind: "fact", content: "x".repeat(200) + i, source: "kill",
    scope: "agent", ts: { validAt: at, assertedAt: at } });
}
`;

function killMidway(target: "canonical" | "file", root: string, ms: number): Promise<void> {
  const script = join(root, "..", "endless-" + target + "-" + process.pid + ".ts");
  writeFileSync(script, ENDLESS.replaceAll("REPO", REPO), "utf8");
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...NODE_ARGS, script, target, root], { stdio: "ignore" });
    setTimeout(() => child.kill("SIGKILL"), ms);
    child.on("exit", () => {
      rmSync(script, { force: true });
      resolve();
    });
  });
}

describe("P0 跨进程并发 (M5)", () => {
  it("两个进程各写 200 条: canonical 与 FileBackend 都是 400 条, 0 解析错误", () => {
    const out = mkdtempSync(join(tmpdir(), "hx-m5-out-"));
    try {
      const run = spawnSync(
        process.execPath,
        [...NODE_ARGS, join(REPO, "scripts/eval/concurrency.ts"), "--procs", "2", "--each", "200", "--runs", "2", "--out", out],
        { encoding: "utf8" },
      );
      expect(run.status, run.stdout + run.stderr).toBe(0);
      const m5 = JSON.parse(readFileSync(join(out, "M5.json"), "utf8"));
      expect(m5.value).toBe(1);
      expect(m5.allStoredEqualExpected).toBe(true);
      for (const row of m5.rows) {
        expect(row.stored).toBe(400);
        expect(row.parseError).toBe("");
        expect(row.writeErrors).toEqual([0, 0]);
      }
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 120_000);

  it("canonical: 写入中途被 SIGKILL, bundle.json 仍是完整 JSON, 之后照常写入", async () => {
    const root = mkdtempSync(join(tmpdir(), "hx-kill-c-"));
    try {
      await killMidway("canonical", root, 1500);
      const store = new CanonicalStore(root);
      // 不是半个文件: 能完整解析, 且条目 id 连续 (被杀时正在写的那一条要么在、要么不在)。
      const before = store.listMemories("ws_t");
      expect(before.length).toBeGreaterThan(0);
      const ids = new Set(before.map((r) => r.id));
      for (let i = 0; i < before.length; i++) expect(ids.has("k_" + i)).toBe(true);
      // 遗留锁 (持锁进程已死) 被接管, 下一次写入成功。
      store.saveMemory(record("after-kill"));
      expect(store.listMemories("ws_t").length).toBe(before.length + 1);
      // 目录里不残留锁文件与 .tmp (临时文件可能留一个孤儿, 但不会被当成 bundle)。
      const dir = join(root, "banks", "ws_t");
      expect(existsSync(join(dir, "bundle.json.lock"))).toBe(false);
      expect(store.listBanks()).toEqual(["ws_t"]);
      expect(readdirSync(dir).filter((n) => n.endsWith(".json"))).toEqual(["bundle.json"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("FileBackend: 写入中途被 SIGKILL, 真相文件全部可解析, 之后照常写入", async () => {
    const root = mkdtempSync(join(tmpdir(), "hx-kill-f-"));
    try {
      await killMidway("file", root, 2000);
      const { entries, skipped } = scanTruth(root);
      expect(skipped).toEqual([]);
      expect(entries.size).toBeGreaterThan(0);
      const store = new FileBackend({ root });
      const at = "2026-09-01T00:00:00.000Z";
      store.add({ id: "after-kill", kind: "fact", content: "after", source: "t", scope: "agent", ts: { validAt: at, assertedAt: at } });
      store.close();
      const after = scanTruth(root);
      expect(after.skipped).toEqual([]);
      expect(after.entries.size).toBe(entries.size + 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("锁: 释放后能再次获取; 持锁期间其它进程等待而不是覆盖; 死进程的锁被接管", () => {
    const root = mkdtempSync(join(tmpdir(), "hx-lock-"));
    const lock = join(root, "x.lock");
    try {
      const release = acquireFileLock(lock);
      expect(existsSync(lock)).toBe(true);
      // 持锁时另一把同名锁在超时内拿不到。
      expect(() => acquireFileLock(lock, { timeoutMs: 200 })).toThrow(/file lock timeout/);
      release();
      expect(existsSync(lock)).toBe(false);
      const again = acquireFileLock(lock, { timeoutMs: 200 });
      again();
      // 死进程留下的锁: 写一个不存在的 pid, 应被立即接管。
      const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
      writeFileSync(lock, dead.stdout + " " + Date.now());
      const taken = acquireFileLock(lock, { timeoutMs: 1000 });
      expect(readFileSync(lock, "utf8").split(" ")[0]).toBe(String(process.pid));
      taken();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
