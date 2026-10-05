// scripts/kb-index.ts — 把外部 Markdown 目录**编译**成知识库条目 (kind: "doc")。
//
// 为什么独立成脚本 (2026-09-20, §795): 知识库与记忆是**两类东西** ——
//   · 记忆: 从对话里提炼, 参与保底注入, 有衰减与治理;
//   · 知识库: 外部文档的镜像, **只可查**, 不参与保底注入 (见 always-on 的 doc 排除), **不衰减**。
// 两者共用引擎 (FTS + 6 通道 + 覆盖率门槛), 但**分目录、分 kind、分注入通道**。
//
// 切片判据: 按 **H2 (`## `) 切**, 而不是固定字符窗口 ——
//   · 文档本身已有 `hxid` frontmatter + `##` 小节, 那是**作者给出的**语义边界;
//   · 固定窗口会切断语义 (实测中位 573 字 / 最长 10534 字, 窗口切法无法同时适配两者);
//   · 与 `src/wiki/page.ts` 的"小节 = 证据与演化的最小粒度"同构。
//
// 地址: `<hxid>-s<N>`。**读写共用同一地址** —— 重跑时同一个 `##` 得到同一个 id,
// 于是"文档改了"只影响该文件的切片, 不必全量重建 (增量前提)。
//
// 增量: 用**源文件 sha256** 判断是否需要重算。文件未变 ⇒ 跳过 (不写盘)。
//
// 用法:
//   node --experimental-strip-types scripts/kb-index.ts --src <文档目录> [--root <记忆根>] [--dry-run]
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { openMemoryStack } from "../src/app/stack.ts";

/** 命令行参数。 */
const argv = process.argv.slice(2);
const argOf = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

const srcDir = argOf("--src");
if (!srcDir) {
  console.error("用法: kb-index.ts --src <文档目录> [--root <记忆根>] [--dry-run]");
  process.exit(2);
}
const dryRun = argv.includes("--dry-run");
const root = argOf("--root") ?? join(process.env.HOME ?? "", ".dsh", "hx-memory");

/** 递归收集 .md。 */
function walk(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (name.endsWith(".md")) out.push(full);
  }
  return out;
}

interface Slice {
  id: string;
  title: string;
  h2: string;
  body: string;
  tags: string[];
  file: string;
}

/**
 * 把一个文档切成条目。
 *
 * id 规则: `<hxid>-s<N>` (`N` 是切片序号)。**不含文件名** —— 文件改名不该改变条目身份
 * (那是"地址稳定"的要求; 文件名放在 `source` 里供溯源)。
 */
export function sliceDoc(path: string, relTo: string): Slice[] {
  const raw = readFileSync(path, "utf8");
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(raw);
  const head = fm?.[1] ?? "";
  const body = fm ? raw.slice(fm[0].length) : raw;
  const hxid = /^hxid:\s*"?([A-Za-z0-9_-]+)"?/m.exec(head)?.[1];
  const title = /^title:\s*"?(.*?)"?\s*$/m.exec(head)?.[1] ?? basename(path, ".md");
  const tagLine = /^tags:\s*(.*)$/m.exec(head)?.[1] ?? "";
  const tags = [...tagLine.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
  // 无 hxid 的文档也要能进 (用路径派生稳定 id, 不静默丢弃)。
  const base = hxid ?? createHash("sha256").update(relative(relTo, path)).digest("hex").slice(0, 12);
  const parts = body.split(/\r?\n(?=## )/);
  const out: Slice[] = [];
  parts.forEach((part, i) => {
    const text = part.trim();
    if (!text) return;
    const h2 = /^##\s+(.+)$/m.exec(text)?.[1]?.trim() ?? "";
    out.push({
      id: base + "-s" + i,
      title,
      h2: h2 || title,
      body: "# " + title + (h2 ? " / " + h2 : "") + "\n\n" + text,
      tags,
      file: relative(relTo, path),
    });
  });
  return out;
}

const files = walk(srcDir).sort();
const stack = openMemoryStack(root, { episodeRetentionDays: 0, embedder: null });
let added = 0;
let skippedFile = 0;
let totalSlices = 0;
const skipped: string[] = [];
try {
  // 已有条目的 source 集合 (增量判据: 同一文件 + 同一内容哈希 ⇒ 跳过)。
  const existing = new Map<string, string>();
  for (const e of stack.store.all()) {
    if (e.kind === "doc" && String(e.source).startsWith("kb:")) existing.set(e.id, e.content);
  }
  for (const f of files) {
    const slices = sliceDoc(f, srcDir);
    totalSlices += slices.length;
    const h = createHash("sha256").update(readFileSync(f)).digest("hex").slice(0, 16);
    // 增量: 该文件的所有切片都在, 且带同一内容哈希 ⇒ 跳过。
    const allPresent = slices.every((s) => existing.get(s.id)?.includes("kbhash:" + h));
    if (allPresent && slices.length > 0) {
      skippedFile++;
      continue;
    }
    for (const s of slices) {
      if (dryRun) {
        added++;
        continue;
      }
      stack.store.add({
        id: s.id,
        kind: "doc",
        scope: "global",
        source: "kb:" + s.file,
        content: s.body + "\n\n<!-- kbhash:" + h + " -->",
        tags: s.tags,
        ts: { validAt: "2026-01-01T00:00:00Z", assertedAt: new Date().toISOString() },
      } as never);
      added++;
    }
  }
  console.log("kb-index: " + files.length + " 个文件 ⇒ " + totalSlices + " 个切片");
  console.log("  新增/更新: " + added + "; 跳过未变文件: " + skippedFile);
  console.log("  库: " + root);
  console.log("  " + (dryRun ? "(dry-run, 未写盘)" : "已写盘"));
  if (skipped.length) console.log("  跳过: " + skipped.length);
} finally {
  stack.close();
}
