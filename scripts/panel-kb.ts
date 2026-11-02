// scripts/panel-kb.ts — HX-Memory 面板后端的一部分 (2026-11-02 从 panel-server.ts 按职责拆出, verify-structure 400 行约束)。
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { extname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { openMemoryStack, type MemoryStack } from "../src/app/stack.ts";
import { embedderFromConfig, embeddingSource, encryptSecret, readEmbeddingConfig, resolveSecret, type EmbeddingConfig } from "../src/app/embedding-config.ts";
import { DEFAULT_KB_DIRS, KbSync, kbNamespace, kbSourceNamespace, walkMarkdown } from "../src/kb/kb-sync.ts";
import { CanonicalStore } from "../src/external/store.ts";
import { compensateAtTurnEnd, createDetector, LEXICON_MODEL } from "../src/frustration/detect.ts";
import { explain, type LinearModel } from "../src/frustration/classifier.ts";
import { extractFeatures } from "../src/frustration/features.ts";
import { MODEL } from "../src/frustration/model.ts";
import { CATALOG, STATE_TEXT, stateOf } from "./eval/report.ts";
import { DECAY, NORMATIVE_KINDS, SUPERSEDED_FACTOR, TOPIC_OVERLAP, TOPIC_STRONG, ageDaysOf, decayCurve, effectiveConfidence, retention, retentionOf, supersedeByRecency } from "../src/kernel/temporal.ts";
import { selectAlwaysOnDetailed } from "../src/trigger/always-on.ts";
import { qualityOf, summarizeQuality, QUALITY_MIN_LEN, LOW_QUALITY_LEN } from "../src/app/memory-quality.ts";
import { estimateTokens } from "../src/kernel/ranking.ts";
import { EVAL_DIR, type KbSource, MEMORY_ROOT, loadConfig, readJson } from "./panel-ctx.ts";
import { entries, getStack, stackErrorOf } from "./panel-state.ts";

export function primarySource(): KbSource {
  const k3 = readJson(join(EVAL_DIR, "K3.json"));
  const root = process.env.HX_KB_ROOT?.trim() || (typeof k3?.src === "string" ? k3.src : "/home/hx/Loli/code/HXLoLis/HXLoLi");
  return { root, dirs: [...DEFAULT_KB_DIRS], addedAt: "内置 (HX_KB_ROOT 或 eval-out/K3.json 的 src)" };
}
/** 库里 kb 条目: 命名空间 → 文件 → 切片数。 */
export function ingested(): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  for (const e of entries()) {
    if (e.kind !== "doc" || e.status === "shadow") continue;
    const o = kbSourceNamespace(e.source);
    if (!o) continue;
    const m = out.get(o.ns) ?? new Map<string, number>();
    m.set(o.file, (m.get(o.file) ?? 0) + 1);
    out.set(o.ns, m);
  }
  return out;
}
export function sourceView(src: KbSource, primary: boolean, ing: Map<string, Map<string, number>>) {
  const ns = primary ? "" : kbNamespace(src.root);
  const ok = existsSync(src.root);
  const files = ok ? walkMarkdown(src.root, src.dirs).map((f) => relative(src.root, f).split(sep).join("/")) : [];
  const have = ing.get(ns) ?? new Map<string, number>();
  const groups: Record<string, { files: number; ingested: number }> = {};
  let ingestedFiles = 0;
  for (const f of files) {
    const g = f.split("/")[0]!;
    const x = (groups[g] ??= { files: 0, ingested: 0 });
    x.files++;
    if (have.has(f)) { x.ingested++; ingestedFiles++; }
  }
  const fileSet = new Set(files);
  const orphan = [...have.keys()].filter((f) => !fileSet.has(f)).length; // 库里有、源目录已没有 (下次同步会删)
  const slices = [...have.values()].reduce((a, b) => a + b, 0);
  const state = !ok ? "源目录不存在" : files.length === 0 ? "没有 .md" : ingestedFiles === files.length && orphan === 0 ? "已同步" : ingestedFiles === 0 ? "未入库" : "部分入库";
  return { root: src.root, dirs: src.dirs, primary, namespace: ns || "(主语料)", exists: ok, files: files.length, ingestedFiles, slices, orphan, groups, state, addedAt: src.addedAt, lastSync: src.lastSync ?? null, missingDirs: src.dirs.filter((d) => !existsSync(join(src.root, d))) };
}
export function kbView() {
  const cfg = loadConfig();
  const ing = ingested();
  const prim = { ...primarySource(), lastSync: cfg.primaryLastSync };
  return { memoryRoot: MEMORY_ROOT, sources: [sourceView(prim, true, ing), ...cfg.kb.map((k) => sourceView(k, false, ing))] };
}
export function kbFiles(root: string) {
  const cfg = loadConfig();
  const prim = primarySource();
  const src = root === prim.root ? prim : cfg.kb.find((k) => k.root === root);
  if (!src) return null;
  const have = ingested().get(root === prim.root ? "" : kbNamespace(root)) ?? new Map<string, number>();
  return walkMarkdown(src.root, src.dirs).map((full) => {
    const rel = relative(src.root, full).split(sep).join("/");
    const st = statSync(full);
    return { file: rel, group: rel.split("/").slice(0, 2).join("/"), bytes: st.size, mtime: st.mtime.toISOString(), slices: have.get(rel) ?? 0 };
  });
}
export function runSync(src: KbSource, primary: boolean) {
  const s = getStack();
  if (!s) throw new Error(stackErrorOf() ?? "记忆栈打不开");
  const r = new KbSync({ store: s.store as never, root: src.root, dirs: src.dirs, ...(primary ? {} : { namespace: kbNamespace(src.root) }) }).syncOnce();
  return { at: new Date().toISOString(), files: r.files, slices: r.slices, added: r.added, updated: r.updated, removed: r.removed, unchanged: r.unchanged, ms: r.ms, failed: r.failed.slice(0, 50), failedCount: r.failed.length, warnings: r.warnings.slice(0, 50), warningCount: r.warnings.length };
}

// ---------- 概览: 15 个指标 ----------
