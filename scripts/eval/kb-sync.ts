// scripts/eval/kb-sync.ts — EVAL.md K4 博客同步延迟 (判据 J2.1)。
//
// 做法 (不改你的博客): 把 --src 下的 blog/ ai-docs/ docs/ 复制到临时目录, 在副本上启动 KbSync 轮询 (默认 5 s 一轮),
// 等首轮全量同步完成后做 3 个动作, 每个动作都量「写入文件 → store.searchText 命中新内容」的秒数:
//   · 改 1 篇: 在第一篇文章末尾追加一个唯一标记词, 量到它可检索;
//   · 加 1 篇: 新建一篇带唯一标记词的文章, 量到它可检索;
//   · 删 1 篇: 删掉第二篇文章, 量到它的切片在库里 0 残留 (按 source 查, 不只看检索)。
// K4 = 三者中的最大秒数, 阈值 <= 60 s, 且删除残留 = 0。单个动作超过 --timeout (默认 90 s) 记为失败。
//
// 用法: node --experimental-strip-types --no-warnings scripts/eval/kb-sync.ts --src /home/hx/Loli/code/HXLoLis/HXLoLi [--interval 5000] [--out eval-out]
// 不给 --src 时用内置的 3 篇小样例 (只验证机制, 输出里 corpus 标为 "builtin", 不能当 K4 的正式结果)。
// 退出码: 0 达标; 1 超时或有残留; 2 参数错误; 3 运行出错。
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
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
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

async function main(): Promise<number> {
  const src = arg("--src");
  const interval = Number(arg("--interval") ?? 5000);
  const timeoutS = Number(arg("--timeout") ?? 90);
  const out = resolve(REPO, arg("--out") ?? "eval-out");
  if (src && !existsSync(src)) {
    console.error("源目录不存在: " + src);
    return 2;
  }
  const work = mkdtempSync(join(tmpdir(), "kb-k4-src-"));
  const mem = mkdtempSync(join(tmpdir(), "kb-k4-mem-"));
  if (src) {
    for (const d of DEFAULT_KB_DIRS) if (existsSync(join(src, d))) cpSync(join(src, d), join(work, d), { recursive: true });
  } else {
    mkdirSync(join(work, "blog"), { recursive: true });
    for (const [i, w] of ["甲", "乙", "丙"].entries()) writeFileSync(join(work, "blog", `s${i}.md`), `---\nhxid: s${i}\ntitle: ${w}\n---\n\n## 小节\n\n${w}的正文。`);
  }
  const stack = openMemoryStack(mem, { episodeRetentionDays: 0, embedder: null });
  const sync = new KbSync({ store: stack.store as never, root: work });
  const t0 = Date.now();
  sync.syncOnce();
  const initialMs = Date.now() - t0;
  sync.start(interval);
  const files = walkMarkdown(work, DEFAULT_KB_DIRS);
  const rel = (f: string) => relative(work, f).split("\\").join("/");
  const token = () => "kbprobe" + Math.random().toString(36).slice(2, 10);
  const wait = async (ok: () => boolean): Promise<number | null> => {
    const s = Date.now();
    while (Date.now() - s < timeoutS * 1000) {
      if (ok()) return (Date.now() - s) / 1000;
      await sleep(200);
    }
    return null;
  };
  const hit = (t: string) => stack.store.searchText(t, 5).some((e) => e.kind === "doc");
  const results: Array<{ action: string; file: string; seconds: number | null; residual?: number }> = [];
  try {
    if (files.length < 2) throw new Error("源目录少于 2 篇文章, 无法做改/删");
    const tm = token();
    writeFileSync(files[0]!, readFileSync(files[0]!, "utf8") + "\n\n## 探针\n\n" + tm + "\n");
    results.push({ action: "modify", file: rel(files[0]!), seconds: await wait(() => hit(tm)) });
    const ta = token();
    const added = join(dirname(files[0]!), "kb-probe-" + ta + ".md");
    writeFileSync(added, `---\ntitle: probe\n---\n\n## 探针\n\n${ta}\n`);
    results.push({ action: "add", file: rel(added), seconds: await wait(() => hit(ta)) });
    const del = rel(files[1]!);
    unlinkSync(files[1]!);
    const residual = () => stack.store.all().filter((e) => e.kind === "doc" && e.status !== "shadow" && e.source === "kb:" + del).length;
    const s = await wait(() => residual() === 0);
    results.push({ action: "delete", file: del, seconds: s, residual: residual() });
  } finally {
    sync.stop();
    stack.close();
    rmSync(work, { recursive: true, force: true });
    rmSync(mem, { recursive: true, force: true });
  }
  const secs = results.map((r) => r.seconds);
  const k4 = secs.some((v) => v === null) ? null : Math.max(...(secs as number[]));
  const residual = results.find((r) => r.action === "delete")?.residual ?? null;
  const pass = k4 !== null && k4 <= 60 && residual === 0 && !!src;
  mkdirSync(out, { recursive: true });
  writeFileSync(
    join(out, "K4.json"),
    JSON.stringify({ metric: "K4", value: k4, unit: "s", threshold: 60, residual, pass, corpus: src ? "real" : "builtin", src: src ?? null, files: files.length, intervalMs: interval, initialSyncMs: initialMs, actions: results, at: new Date().toISOString() }, null, 2) + "\n",
  );
  console.log(`K4=${k4 ?? "超时"} s (间隔 ${interval} ms, 首轮 ${initialMs} ms, ${files.length} 篇)  删除残留=${residual}  corpus=${src ? "real" : "builtin"}`);
  for (const r of results) console.log(`  ${r.action} ${r.file}: ${r.seconds ?? "超时"} s`);
  writeReport(REPO);
  return pass ? 0 : src ? 1 : 2;
}

main().then(
  (c) => process.exit(c),
  (e) => {
    console.error(e);
    process.exit(3);
  },
);
