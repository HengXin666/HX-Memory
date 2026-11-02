// src/kb/kb-sync.ts — 博客知识库同步器 (PLAN.md P2, 判据 J2.1–J2.5, EVAL.md K3/K4)。
//
// 做什么: 把外部 Markdown 目录 (博客的 blog/ ai-docs/ docs/) 同步成知识库条目 (kind: "doc", source: "kb:<相对路径>"),
// 新增、修改、删除都在一次 syncOnce() 里对齐; start() 按固定间隔轮询, 让改动在 60 s 内可检索 (K4)。
//
// 与 scripts/kb-index.ts 的区别 (那个脚本只增不删):
//   · 删除: 源文件删了 ⇒ 它的切片全部 remove; 文件变短 (切片从 5 个变 3 个) ⇒ 多出的 s3/s4 也 remove;
//   · hxid 冲突: 两个文件写了同一个 hxid ⇒ 第二个改用路径派生 id, 并记进 warnings (不再静默互相覆盖);
//   · 失败清单: 读不了、空正文的文件进 failed (K3 的分母不变, 分子少了它们, 排查看 reason);
//   · 隐藏目录 (.hark-bak 等) 与 node_modules 跳过。
//
// 为什么轮询而不是 fs.watch: fs.watch 递归监听在 Linux 上依赖 Node 版本, 编辑器「写临时文件再 rename」会丢事件;
// 轮询先比 (mtime, size), 变了才读文件算哈希, 1213 个文件一轮只是 1213 次 stat。间隔默认 5 s, 远低于 K4 的 60 s。
//
// 只读约束 (J2.5): 本模块只写 kind: "doc" 条目; doc 条目不进保底注入 (trigger/always-on.ts 显式排除), 也不参与衰减。
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { isLiveEntry } from "../kernel/visibility.ts";
import type { MemoryEntry } from "../kernel/types.ts";

export interface KbSlice {
  id: string;
  title: string;
  heading: string;
  body: string;
  tags: string[];
  file: string;
}

/** 从文档原文切片 (按 `## ` 切; 与 scripts/kb-index.ts 的 sliceDoc 同一规则, 但不碰文件系统)。 */
export function sliceMarkdown(raw: string, file: string): { hxid: string | null; slices: KbSlice[] } {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  const head = fm?.[1] ?? "";
  const body = fm ? raw.slice(fm[0].length) : raw;
  const hxid = /^hxid:\s*["']?([A-Za-z0-9_-]+)["']?/m.exec(head)?.[1] ?? null;
  const title = /^title:\s*["']?(.*?)["']?\s*$/m.exec(head)?.[1] || basename(file).replace(/\.mdx?$/, "");
  const tagLine = /^tags:\s*(.*)$/m.exec(head)?.[1] ?? "";
  const tags = [...tagLine.matchAll(/["']([^"']+)["']/g)].map((m) => m[1]!);
  const base = hxid ?? pathId(file);
  const slices: KbSlice[] = [];
  body.split(/\r?\n(?=## )/).forEach((part, i) => {
    const text = part.trim();
    if (!text) return;
    const h2 = /^##\s+(.+)$/m.exec(text)?.[1]?.trim() ?? "";
    slices.push({
      id: base + "-s" + i,
      title,
      heading: h2 || title,
      body: "# " + title + (h2 ? " / " + h2 : "") + "\n\n" + text,
      tags,
      file,
    });
  });
  return { hxid, slices };
}

/** 路径派生的稳定 id (无 hxid 或 hxid 冲突时用)。 */
export function pathId(file: string): string {
  return "kb" + createHash("sha256").update(file.split(sep).join("/")).digest("hex").slice(0, 12);
}

const HASH_RE = /<!-- kbhash:([0-9a-f]+) -->/;

/** 同步器只依赖存储的这几个方法 (FileBackend 满足)。 */
export interface KbStore {
  all(): Array<{ id: string; kind: string; source?: string; content: string; status?: string }>;
  add(entry: Record<string, unknown>): unknown;
  remove(id: string): void;
}

export interface KbSyncReport {
  files: number;
  slices: number;
  added: number;
  updated: number;
  removed: number;
  unchanged: number;
  /** 产出 0 个切片或读失败的文件 (K3 失败清单)。 */
  failed: Array<{ file: string; reason: string }>;
  warnings: string[];
  ms: number;
}

export interface KbSyncOptions {
  store: KbStore;
  /** 博客根目录。 */
  root: string;
  /** 根下要同步的子目录; 默认 blog / ai-docs / docs。不存在的子目录跳过。 */
  dirs?: readonly string[];
  /** 可注入时钟 (测试)。 */
  now?: () => number;
  onReport?: (r: KbSyncReport) => void;
  /**
   * 命名空间 (2026-11-01, 面板「增量加知识库路径」): 缺省 = 主语料, source 为 `kb:<相对路径>`, 切片 id 不变 (向后兼容)。
   * 给了 ns ⇒ source 为 `kb:@<ns>/<相对路径>`, 切片 id 前缀 `<ns>-`。
   *
   * 为什么必须有它: syncOnce 会删掉库里所有「不在本轮源目录里」的 kb 条目。两个根各开一个 KbSync 时,
   * 同步第二个根会把第一个根的 1022 篇全部删掉 (实测: 面板同步临时目录后主语料 removed = 全部)。
   * 有了命名空间, 每个 KbSync 只看、只删自己那一份: 主语料不看 `kb:@`, 增量路径只看 `kb:@<ns>/`。
   */
  namespace?: string;
}

/** 按根目录派生的命名空间 (面板用它给增量路径起名; 同一根目录永远得到同一个 ns)。 */
export function kbNamespace(root: string): string {
  return "r" + createHash("sha256").update(root.replace(/\/+$/, "")).digest("hex").slice(0, 10);
}

/** 一条 kb 条目的 source 属于哪个命名空间 ("" = 主语料); 不是 kb 条目返回 null。 */
export function kbSourceNamespace(source: unknown): { ns: string; file: string } | null {
  const s = String(source ?? "");
  if (!s.startsWith("kb:")) return null;
  const m = /^kb:@([A-Za-z0-9_-]+)\/(.*)$/.exec(s);
  return m ? { ns: m[1]!, file: m[2]! } : { ns: "", file: s.slice(3) };
}

export const DEFAULT_KB_DIRS = ["blog", "ai-docs", "docs"] as const;

export function walkMarkdown(root: string, dirs: readonly string[]): string[] {
  const out: string[] = [];
  const visit = (dir: string) => {
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of names) {
      if (name.startsWith(".") || name === "node_modules") continue;
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) visit(full);
      else if (name.endsWith(".md")) out.push(full);
    }
  };
  for (const d of dirs) visit(join(root, d));
  return out;
}

export class KbSync {
  private readonly dirs: readonly string[];
  private readonly now: () => number;
  /** 上一轮每个文件的 (mtime, size, 哈希, 切片 id)。 */
  private seen = new Map<string, { mtime: number; size: number; hash: string; ids: string[] }>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  private readonly ns: string;

  // 显式字段, 不用参数属性: Node 26 strip-only 模式拒绝 constructor(private x)。
  private readonly opts: KbSyncOptions;

  constructor(opts: KbSyncOptions) {
    this.opts = opts;
    this.dirs = opts.dirs ?? DEFAULT_KB_DIRS;
    this.now = opts.now ?? Date.now;
    this.ns = opts.namespace ?? "";
    if (this.ns && !/^[A-Za-z0-9_-]+$/.test(this.ns)) throw new Error("kb namespace 只能是字母数字下划线连字符: " + this.ns);
  }

  /** 切片 id → 库里的 id (主语料原样)。 */
  private sid(id: string): string {
    return this.ns ? this.ns + "-" + id : id;
  }

  /** 一轮全量对齐。幂等: 源目录不变时第二轮 added = updated = removed = 0。 */
  syncOnce(): KbSyncReport {
    const t0 = this.now();
    const { store, root } = this.opts;
    const report: KbSyncReport = { files: 0, slices: 0, added: 0, updated: 0, removed: 0, unchanged: 0, failed: [], warnings: [], ms: 0 };
    // 库里现有的 kb 条目: id -> { file, hash }
    const existing = new Map<string, { file: string; hash: string }>();
    for (const e of store.all()) {
      if (e.kind !== "doc" || !isLiveEntry(e as { status?: MemoryEntry["status"] })) continue; // 可见性统一走 kernel/visibility.ts (verify-structure 禁手写 shadow 比较)
      const owned = kbSourceNamespace(e.source);
      if (!owned || owned.ns !== this.ns) continue; // 别的命名空间的条目: 不看、不删
      existing.set(e.id, { file: owned.file, hash: HASH_RE.exec(e.content)?.[1] ?? "" });
    }
    const files = walkMarkdown(root, this.dirs);
    report.files = files.length;
    const desired = new Set<string>();
    const owner = new Map<string, string>(); // hxid -> 第一个声明它的文件
    const next = new Map<string, { mtime: number; size: number; hash: string; ids: string[] }>();
    for (const full of files) {
      const rel = relative(root, full).split(sep).join("/");
      let st;
      try {
        st = statSync(full);
      } catch (e) {
        report.failed.push({ file: rel, reason: "stat 失败: " + String(e) });
        continue;
      }
      const prev = this.seen.get(rel);
      // 快路径: mtime 与 size 都没变, 且上一轮的切片都还在库里 ⇒ 不读文件
      if (prev && prev.mtime === st.mtimeMs && prev.size === st.size && prev.ids.length && prev.ids.every((id) => existing.get(this.sid(id))?.hash === prev.hash)) {
        for (const id of prev.ids) desired.add(this.sid(id));
        report.slices += prev.ids.length;
        report.unchanged += prev.ids.length;
        next.set(rel, prev);
        const hx = prev.ids[0]!.replace(/-s\d+$/, "");
        if (!owner.has(hx)) owner.set(hx, rel);
        continue;
      }
      let raw: string;
      try {
        raw = readFileSync(full, "utf8");
      } catch (e) {
        report.failed.push({ file: rel, reason: "读取失败: " + String(e) });
        continue;
      }
      if (raw.includes("\uFFFD")) report.warnings.push(rel + ": 含无法解码的字节 (非 UTF-8?)");
      const hash = createHash("sha256").update(raw).digest("hex").slice(0, 16);
      let { hxid, slices } = sliceMarkdown(raw, rel);
      if (hxid && owner.has(hxid) && owner.get(hxid) !== rel) {
        report.warnings.push(rel + ": hxid " + hxid + " 已被 " + owner.get(hxid) + " 使用, 改用路径派生 id");
        const alt = pathId(rel);
        slices = slices.map((s) => ({ ...s, id: s.id.replace(hxid + "-s", alt + "-s") }));
        hxid = alt;
      }
      owner.set(hxid ?? pathId(rel), rel);
      if (!slices.length) {
        report.failed.push({ file: rel, reason: "空正文 (没有可切的内容)" });
        next.set(rel, { mtime: st.mtimeMs, size: st.size, hash, ids: [] });
        continue;
      }
      for (const s of slices) {
        const id = this.sid(s.id);
        desired.add(id);
        report.slices++;
        const cur = existing.get(id);
        if (cur && cur.hash === hash && cur.file === rel) {
          report.unchanged++;
          continue;
        }
        store.add({
          id,
          kind: "doc",
          scope: "global",
          source: "kb:" + (this.ns ? "@" + this.ns + "/" : "") + rel,
          content: s.body + "\n\n<!-- kbhash:" + hash + " -->",
          tags: s.tags,
          ts: { validAt: new Date(st.mtimeMs).toISOString(), assertedAt: new Date(this.now()).toISOString() },
        });
        if (cur) report.updated++;
        else report.added++;
      }
      next.set(rel, { mtime: st.mtimeMs, size: st.size, hash, ids: slices.map((s) => s.id) });
    }
    for (const id of existing.keys()) {
      if (desired.has(id)) continue;
      store.remove(id);
      report.removed++;
    }
    this.seen = next;
    report.ms = this.now() - t0;
    this.opts.onReport?.(report);
    return report;
  }

  /** 先同步一轮, 然后每 intervalMs 轮询一次。重复调用无副作用。 */
  start(intervalMs = 5000): void {
    if (this.timer) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private tick(): void {
    if (this.running) return; // 上一轮没跑完就跳过, 不叠加
    this.running = true;
    try {
      this.syncOnce();
    } catch (e) {
      this.opts.onReport?.({ files: 0, slices: 0, added: 0, updated: 0, removed: 0, unchanged: 0, failed: [{ file: "*", reason: String(e) }], warnings: [], ms: 0 });
    } finally {
      this.running = false;
    }
  }
}
