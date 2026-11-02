// scripts/eval/kb-coverage.ts — EVAL.md K3 博客入库覆盖率 (判据 J2.2)。
//
// K3 = 产出至少 1 个切片、且切片真的进了库的源文件数 ÷ 源文件数, 阈值 = 1.00。
// 被测对象: src/kb/kb-sync.ts 的 KbSync.syncOnce(), 写进一个临时记忆根 (不碰你的 ~/.dsh/hx-memory, 不改博客)。
// 「进了库」按库里 kind: doc 条目的 source 去重计数, 不按同步器自报的计数。
//
// 用法: node --experimental-strip-types --no-warnings scripts/eval/kb-coverage.ts --src /home/hx/Loli/code/HXLoLis/HXLoLi [--out eval-out]
// 退出码: 0 K3 = 1.00; 1 K3 < 1.00 (失败清单在 eval-out/K3.json, 按原因分组); 2 参数错误或源目录不存在; 3 运行出错。
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openMemoryStack } from "../../src/app/stack.ts";
import { DEFAULT_KB_DIRS, KbSync, walkMarkdown } from "../../src/kb/kb-sync.ts";
import { writeReport } from "./report.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const arg = (n: string) => {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

function main(): number {
  const src = arg("--src");
  const out = resolve(REPO, arg("--out") ?? "eval-out");
  if (!src || !existsSync(src)) {
    console.error("用法: kb-coverage.ts --src <博客根> (目录不存在: " + src + ")");
    return 2;
  }
  const mem = mkdtempSync(join(tmpdir(), "kb-k3-"));
  const stack = openMemoryStack(mem, { episodeRetentionDays: 0, embedder: null });
  try {
    const files = walkMarkdown(src, DEFAULT_KB_DIRS).map((f) => relative(src, f).split("\\").join("/"));
    const rep = new KbSync({ store: stack.store as never, root: src }).syncOnce();
    const inStore = new Set(
      stack.store.all().filter((e) => e.kind === "doc" && e.status !== "shadow").map((e) => String(e.source).replace(/^kb:/, "")),
    );
    const covered = files.filter((f) => inStore.has(f)).length;
    const k3 = files.length ? covered / files.length : null;
    const missing = files.filter((f) => !inStore.has(f));
    const reasons = new Map(rep.failed.map((x) => [x.file, x.reason]));
    const byReason: Record<string, string[]> = {};
    for (const f of missing) (byReason[reasons.get(f)?.replace(/:.*/, "") ?? "未知 (同步器没报失败, 但库里没有)"] ??= []).push(f);
    const perDir: Record<string, { files: number; covered: number }> = {};
    for (const f of files) {
      const d = f.split("/")[0]!;
      const b = (perDir[d] ??= { files: 0, covered: 0 });
      b.files++;
      if (inStore.has(f)) b.covered++;
    }
    mkdirSync(out, { recursive: true });
    writeFileSync(
      join(out, "K3.json"),
      JSON.stringify({ metric: "K3", value: k3, threshold: 1, n: files.length, covered, slices: rep.slices, perDir, pass: k3 === 1, at: new Date().toISOString(), src, syncMs: rep.ms, failedByReason: byReason, warnings: rep.warnings.slice(0, 200), warningCount: rep.warnings.length }, null, 2) + "\n",
    );
    console.log(`K3=${k3 === null ? "n/a" : k3.toFixed(4)} (${covered}/${files.length} 个文件, ${rep.slices} 个切片, ${rep.ms} ms)  warnings=${rep.warnings.length}`);
    for (const [r, fs] of Object.entries(byReason)) console.log(`  失败 ${r}: ${fs.length} 个, 例 ${fs.slice(0, 3).join(", ")}`);
    writeReport(REPO);
    return k3 === 1 ? 0 : 1;
  } finally {
    stack.close();
    rmSync(mem, { recursive: true, force: true });
  }
}

try {
  process.exitCode = main();
} catch (e) {
  console.error(e);
  process.exitCode = 3;
}
