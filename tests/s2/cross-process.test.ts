// tests/s2/cross-process.test.ts — 跨进程共享索引 (真并发: 同时启动 + 持锁一段时间)。
// 坑: node:sqlite 默认 busy_timeout=0, 第二个进程在 DDL 阶段就 "database is locked"。
// 注意: 必须用 spawn (异步) 同时启动 —— execFileSync 是串行的, 那样即使删掉 busy_timeout 也会假通过。
import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileBackend } from "../../src/storage/file-store.ts";

const REPO = join(import.meta.dirname, "../..");

/** 子进程脚本: 用 node 的 type-stripping 直接跑 src 里的 TS; 写完后持锁一段时间再退出。 */
const CHILD = `
import { FileBackend } from "REPO/src/storage/file-store.ts";
const [root, prefix, count, holdMs] = process.argv.slice(2);
const store = new FileBackend({ root });
for (let i = 0; i < Number(count); i++) {
  store.add({
    id: prefix + "-" + i,
    kind: "fact",
    content: prefix + " 写入 " + i,
    source: "child:" + prefix,
    scope: "agent",
    ts: { validAt: "2026-09-01T00:00:00.000Z", assertedAt: "2026-09-01T00:00:00.000Z" },
  });
}
await new Promise((r) => setTimeout(r, Number(holdMs)));
store.close();
`;

function runChild(script: string, root: string, prefix: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", script, root, prefix, "15", "250"],
      { stdio: "pipe" },
    );
    let stderr = "";
    child.stderr.on("data", (c) => (stderr += String(c)));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve(0);
      else reject(new Error("child " + prefix + " exited " + code + ": " + stderr.slice(0, 400)));
    });
  });
}

describe("跨进程并发", () => {
  it("两个进程同时打开同一索引并各写 15 条, 都成功且总数正确", async () => {
    const root = mkdtempSync(join(tmpdir(), "hxmem-xproc-"));
    const script = join(root, "child.ts");
    writeFileSync(script, CHILD.replace("REPO", REPO), "utf8");
    try {
      // 同时启动 (子进程写完后各自持锁 250ms, 保证重叠)
      const [a, b] = await Promise.all([runChild(script, root, "a"), runChild(script, root, "b")]);
      expect(a).toBe(0);
      expect(b).toBe(0);
      const store = new FileBackend({ root });
      expect(store.all().length).toBe(30);
      store.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 90_000);

  it("确定性锁竞争: 另一个进程持写锁时, busy_timeout 生效 (对照: 0 必须失败)", async () => {
    const root = mkdtempSync(join(tmpdir(), "hxmem-lock-"));
    const lockScript = join(root, "lock.ts");
    const openScript = join(root, "open.ts");
    // A: 拿住写锁 500ms (BEGIN IMMEDIATE)
    writeFileSync(
      lockScript,
      [
        'import { DatabaseSync } from "node:sqlite";',
        "const [indexPath, holdMs] = process.argv.slice(2);",
        "const db = new DatabaseSync(indexPath);",
        'db.exec("PRAGMA busy_timeout = 5000");',
        'db.exec("CREATE TABLE IF NOT EXISTS lock_probe (id TEXT PRIMARY KEY)");',
        'db.exec("BEGIN IMMEDIATE");',
        "db.exec(\"INSERT OR REPLACE INTO lock_probe (id) VALUES ('held')\");",
        "await new Promise((r) => setTimeout(r, Number(holdMs)));",
        'db.exec("COMMIT");',
        "db.close();",
      ].join("\n"),
      "utf8",
    );
    // B: 用给定 busy_timeout 尝试一次写事务
    writeFileSync(
      openScript,
      [
        'import { DatabaseSync } from "node:sqlite";',
        "const [indexPath, busy] = process.argv.slice(2);",
        "const db = new DatabaseSync(indexPath);",
        'db.exec("PRAGMA busy_timeout = " + busy);',
        'try { db.exec("BEGIN IMMEDIATE"); db.exec("COMMIT"); console.log("OK"); }',
        'catch (error) { console.log("FAILED: " + error.message); }',
        "db.close();",
      ].join("\n"),
      "utf8",
    );

    const run = (script: string, args: string[]) =>
      new Promise<string>((resolve, reject) => {
        const child = spawn(process.execPath, ["--experimental-strip-types", script, ...args], {
          stdio: "pipe",
        });
        let out = "";
        child.stdout.on("data", (c) => (out += String(c)));
        child.on("error", reject);
        child.on("exit", () => resolve(out.trim()));
      });

    try {
      // 先用真实 store 建好索引文件
      const store = new FileBackend({ root });
      store.close();
      const indexPath = join(root, "index.sqlite");

      const holder = run(lockScript, [indexPath, "500"]);
      await new Promise((r) => setTimeout(r, 150)); // 等锁真的被拿住
      const [withTimeout, withoutTimeout] = await Promise.all([
        run(openScript, [indexPath, "5000"]),
        run(openScript, [indexPath, "0"]),
      ]);
      await holder;
      expect(withTimeout).toBe("OK"); // busy_timeout 生效: 等待而不是失败
      expect(withoutTimeout).toContain("FAILED"); // 对照组: 立即失败
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 90_000);
});
