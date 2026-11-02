// scripts/eval/concurrency.ts — EVAL.md 指标 M5「并发写完整率」。
//
// 口径 (EVAL.md 第 1 节 M5): 多个**真实子进程**同时向同一个记忆根写入, 每次运行结束后
// 从磁盘重新读取, 数可读条数; M5 = min(可读条数 / 预期条数), 取所有运行、所有目标里的最小值。
// 任何一次运行出现解析错误 (文件被写坏), M5 记为 0。
//
// 两个目标 (分别对应 REVIEW.md 的两条缺陷):
//   · canonical — 外置宿主的 CanonicalStore (D1: bundle.json 被写坏)
//   · file      — 原生链路的 FileBackend 真相 markdown (D17: 跨进程读-改-写丢更新)
//
// 用法:
//   node --experimental-strip-types --no-warnings scripts/eval/concurrency.ts \
//     --procs 2 --each 200 --runs 20 [--target canonical|file|both] [--out eval-out]
//
// 退出码 (EVAL.md 第 0 节):
//   0 M5 = 1.00 (达标)   1 M5 < 1.00   2 参数无效 / 有效运行数不足   3 子进程无法启动或崩溃
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeReport } from "./report.ts";

const SELF = fileURLToPath(import.meta.url);
const REPO = resolve(dirname(SELF), "../..");
const THRESHOLD = 1.0;

type Target = "canonical" | "file";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

// ---------- 子进程 ----------
async function child(): Promise<void> {
  const [, , , target, root, tag, eachRaw] = process.argv;
  const each = Number(eachRaw);
  let errors = 0;
  let firstError = "";
  if (target === "canonical") {
    const { CanonicalStore } = await import(join(REPO, "src/external/store.ts"));
    const store = new CanonicalStore(root);
    for (let i = 0; i < each; i++) {
      try {
        store.saveMemory({
          id: "m_" + tag + "_" + i,
          bankId: "ws_eval",
          kind: "decision",
          text: tag + " 写入 " + i,
          entities: [],
          supersedes: [],
          status: "active",
          createdAt: new Date().toISOString(),
          indexState: "pending",
        });
      } catch (error) {
        errors++;
        firstError ||= String(error).slice(0, 200);
      }
    }
  } else {
    const { FileBackend } = await import(join(REPO, "src/storage/file-store.ts"));
    const store = new FileBackend({ root });
    const at = "2026-09-01T00:00:00.000Z";
    for (let i = 0; i < each; i++) {
      try {
        store.add({
          id: tag + "-" + i,
          kind: "fact",
          content: tag + " 写入 " + i,
          source: "eval:" + tag,
          scope: "agent",
          ts: { validAt: at, assertedAt: at },
        });
      } catch (error) {
        errors++;
        firstError ||= String(error).slice(0, 200);
      }
    }
    store.close();
  }
  process.stdout.write(JSON.stringify({ errors, firstError }) + "\n");
}

// ---------- 父进程 ----------
interface ChildResult {
  code: number | null;
  errors: number;
  firstError: string;
  stderr: string;
}

function runChild(target: Target, root: string, tag: string, each: number): Promise<ChildResult> {
  return new Promise((resolveChild) => {
    const proc = spawn(
      process.execPath,
      ["--experimental-strip-types", "--no-warnings", SELF, "--child", target, root, tag, String(each)],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    let err = "";
    proc.stdout.on("data", (c) => (out += String(c)));
    proc.stderr.on("data", (c) => (err += String(c)));
    proc.on("error", (e) => resolveChild({ code: -1, errors: each, firstError: String(e), stderr: err }));
    proc.on("exit", (code) => {
      let parsed = { errors: each, firstError: "no child report" };
      try {
        parsed = JSON.parse(out.trim().split("\n").at(-1) ?? "");
      } catch {
        /* 子进程没写出报告: 按全部失败计 */
      }
      resolveChild({ code, errors: parsed.errors, firstError: parsed.firstError, stderr: err.slice(0, 400) });
    });
  });
}

async function count(target: Target, root: string): Promise<{ stored: number; parseError: string }> {
  try {
    if (target === "canonical") {
      const { CanonicalStore } = await import(join(REPO, "src/external/store.ts"));
      return { stored: new CanonicalStore(root).listMemories("ws_eval").length, parseError: "" };
    }
    const { scanTruth } = await import(join(REPO, "src/storage/truth-scan.ts"));
    const { entries, skipped } = scanTruth(root);
    return { stored: entries.size, parseError: skipped.length ? skipped.slice(0, 3).join("; ") : "" };
  } catch (error) {
    return { stored: 0, parseError: String(error).slice(0, 200) };
  }
}

async function main(): Promise<number> {
  const procs = Number(arg("--procs", "2"));
  const each = Number(arg("--each", "200"));
  const runs = Number(arg("--runs", "20"));
  const targetArg = arg("--target", "both");
  const outDir = resolve(arg("--out", join(REPO, "eval-out"))!);
  const targets: Target[] =
    targetArg === "both" ? ["canonical", "file"] : targetArg === "canonical" || targetArg === "file" ? [targetArg] : [];
  if (!(procs >= 2) || !(each >= 1) || !(runs >= 1) || !targets.length) {
    console.error("invalid args: --procs >=2 --each >=1 --runs >=1 --target canonical|file|both");
    return 2;
  }

  const expected = procs * each;
  const rows: Array<Record<string, unknown>> = [];
  let crashed = false;
  for (const target of targets) {
    for (let run = 1; run <= runs; run++) {
      const root = mkdtempSync(join(tmpdir(), "hx-m5-" + target + "-"));
      try {
        const started = Date.now();
        const results = await Promise.all(
          Array.from({ length: procs }, (_, p) => runChild(target, root, "p" + p, each)),
        );
        const ms = Date.now() - started;
        const { stored, parseError } = await count(target, root);
        const childCodes = results.map((r) => r.code);
        if (childCodes.some((c) => c !== 0)) crashed = true;
        const row = {
          target,
          run,
          expected,
          stored,
          writeErrors: results.map((r) => r.errors),
          childCodes,
          parseError,
          firstError: results.map((r) => r.firstError).find(Boolean) ?? "",
          ms,
        };
        rows.push(row);
        console.log(JSON.stringify(row));
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  }

  const ratios = rows.map((r) => (r.parseError ? 0 : (r.stored as number) / expected));
  const value = Math.min(...ratios);
  const pass = !crashed && value >= THRESHOLD;
  const summary = {
    metric: "M5",
    value: Number(value.toFixed(4)),
    threshold: THRESHOLD,
    n: rows.length,
    pass,
    procs,
    each,
    runs,
    targets,
    allStoredEqualExpected: rows.every((r) => r.stored === expected && !r.parseError),
    commit: process.env.GIT_COMMIT ?? "",
    at: new Date().toISOString(),
    rows,
  };
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "M5.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log("M5 = " + summary.value.toFixed(2) + " (threshold " + THRESHOLD.toFixed(2) + ", runs " + rows.length + ")");
  if (crashed) return 3;
  return pass ? 0 : 1;
}

if (process.argv[2] === "--child") {
  await child();
} else {
  process.exitCode = await main();
  writeReport(REPO);
}
