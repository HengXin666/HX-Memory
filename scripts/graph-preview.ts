// scripts/graph-preview.ts — 生成"记忆关系图"的单文件 HTML 预览 (零依赖, 零构建)。
//
// 为什么是独立脚本而不是服务: 这是**预览**, 不是产品面。它只回答"当前库画出来长什么样",
// 因此直接读真相文件 (scanTruth), 不碰索引、不起 HTTP、不需要宿主 —— 一个文件双击就能看。
//
// 边界: 只读。绝不写任何记忆; 输出默认落在 .tmp/ (gitignore 已排除)。
//
// 用法:
//   node --experimental-strip-types scripts/graph-preview.ts
//   node --experimental-strip-types scripts/graph-preview.ts --root ~/.dsh/hx-memory --out /tmp/g.html
//   node --experimental-strip-types scripts/graph-preview.ts --project HX-Memory --no-orphans
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { scanTruth } from "../src/storage/truth-scan.ts";
import type { MemoryEntry, RelationType } from "../src/kernel/types.ts";

const ROOT = resolve(import.meta.dirname, "..");
const TEMPLATE = join(ROOT, "scripts", "lib", "graph-view.html");

/** 与前端 EDGE_COLORS 的键集合保持一致 (未知类型仍会渲染, 只是没有专属颜色)。 */
const KNOWN_EDGE_TYPES: readonly RelationType[] = [
  "relates", "supersedes", "supersededBy", "generalizes", "appliesTo", "source",
  "mentions", "contradicts", "sameAs", "instanceOf", "derivedFrom",
];

interface Flags { root: string; out: string; project?: string; max: number; orphans: boolean; open: boolean; }

function parseFlags(argv: string[]): Flags {
  const flags: Flags = {
    root: join(homedir(), ".dsh", "hx-memory"),
    out: join(ROOT, ".tmp", "memory-graph.html"),
    max: 0,
    orphans: true,
    open: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    const eq = arg.indexOf("=");
    const key = eq >= 0 ? arg.slice(2, eq) : arg.startsWith("--") ? arg.slice(2) : "";
    const val = eq >= 0 ? arg.slice(eq + 1) : (argv[i + 1] ?? "");
    const take = (): string => { if (eq < 0) i++; return val; };
    if (key === "root") flags.root = resolve(take().replace(/^~/, homedir()));
    else if (key === "out") flags.out = resolve(take().replace(/^~/, homedir()));
    else if (key === "project") flags.project = take();
    else if (key === "max") flags.max = Math.max(0, Number(take()) || 0);
    else if (key === "no-orphans") { flags.orphans = false; if (eq < 0 && val === "") i--; }
    else if (key === "open") { flags.open = true; if (eq < 0) i--; }
  }
  return flags;
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max) + "\u2026" : flat;
}

function badCount(entry: MemoryEntry): number {
  return (entry.feedback?.irrelevant ?? 0) + (entry.feedback?.wrong ?? 0);
}

function buildGraph(entries: readonly MemoryEntry[], opts: { project?: string; max: number; orphans: boolean }): Record<string, unknown> {
  const active = entries.filter((e) => e.status !== "shadow");
  const scoped = opts.project ? active.filter((e) => e.project === opts.project) : active;

  // 度数要在过滤前算: 孤立判定必须基于"这张图里"的边, 不是全库。
  const degree = new Map<string, number>();
  const edges: Array<{ from: string; to: string; type: string; weight: number }> = [];
  const dangling = new Map<string, number>();

  for (const entry of scoped) {
    for (const rel of entry.relations ?? []) {
      if (!scoped.some((x) => x.id === rel.toId)) {
        dangling.set(rel.type, (dangling.get(rel.type) ?? 0) + 1);
        continue;
      }
      edges.push({
        from: entry.id,
        to: rel.toId,
        type: rel.type,
        weight: typeof rel.weight === "number" ? Math.round(rel.weight * 1000) / 1000 : 0,
      });
      degree.set(entry.id, (degree.get(entry.id) ?? 0) + 1);
      degree.set(rel.toId, (degree.get(rel.toId) ?? 0) + 1);
    }
  }

  // 节点集: 有边的优先 (importance + 度数), 无边的按时间补; 超上限时截断并显式标记。
  const sorted = scoped.slice().sort((a, b) => {
    const da = degree.get(a.id) ?? 0;
    const db = degree.get(b.id) ?? 0;
    if (da !== db) return db - da;
    return a.ts.assertedAt < b.ts.assertedAt ? 1 : -1;
  });
  const kept = opts.max > 0 ? sorted.slice(0, opts.max) : sorted;
  const keptIds = new Set(kept.map((e) => e.id));
  const inGraph = edges.filter((e) => keptIds.has(e.from) && keptIds.has(e.to));

  const nodes = kept.map((e) => ({
    id: e.id,
    kind: e.kind,
    scope: e.scope,
    status: e.status ?? "active",
    project: e.project ?? null,
    label: truncate(e.content, 120),
    content: truncate(e.content, 900),
    tags: e.tags ?? [],
    entities: e.entities ?? [],
    relations: (e.relations ?? []).filter((r) => keptIds.has(r.toId)).map((r) => ({ type: r.type, to: r.toId, weight: r.weight ?? 0 })),
    degree: degree.get(e.id) ?? 0,
    importance: typeof e.importance === "number" ? e.importance : null,
    reinforcement: typeof e.reinforcement === "number" ? e.reinforcement : null,
    bad: badCount(e),
    confirmed: Boolean(e.confirmedBy),
    source: e.source,
    assertedAt: e.ts.assertedAt,
  }));

  const allEdges = edges.filter((e) => keptIds.has(e.from) && keptIds.has(e.to));
  const byType: Record<string, number> = {};
  for (const e of inGraph) byType[e.type] = (byType[e.type] ?? 0) + 1;

  return {
    generatedAt: new Date().toISOString(),
    stats: {
      totalEntries: scoped.length,
      totalEdges: allEdges.length,
      truncated: kept.length < scoped.length,
      danglingEdges: [...dangling.values()].reduce((a, b) => a + b, 0),
      danglingNote: [...dangling.entries()].map(([t, n]) => t + " x" + n).join(", "),
      knownEdgeTypes: KNOWN_EDGE_TYPES,
      edgeTypes: byType,
      projects: [...new Set(scoped.map((e) => e.project).filter((p): p is string => Boolean(p)))].sort(),
      root: opts.project ? opts.project : "(all)",
      orphanNodes: nodes.filter((n) => n.degree === 0).length,
    },
    nodes,
    edges: allEdges,
  };
}

function main(argv: string[]): number {
  const flags = parseFlags(argv);
  if (!existsSync(join(flags.root, "daily")) && !existsSync(join(flags.root, "rules"))) {
    console.error("找不到记忆根目录: " + flags.root);
    console.error("用 --root <dir> 指定 (默认 ~/.dsh/hx-memory)。");
    return 1;
  }
  const { entries, skipped } = scanTruth(flags.root);
  const graph = buildGraph([...entries.values()], { project: flags.project, max: flags.max, orphans: flags.orphans });
  const stats = graph.stats as Record<string, unknown>;

  const json = JSON.stringify(graph)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  const html = readFileSync(TEMPLATE, "utf8").replace("__HXMEM_DATA__", json);

  mkdirSync(dirname(flags.out), { recursive: true });
  writeFileSync(flags.out, html, "utf8");

  console.log("记忆根目录 : " + flags.root);
  console.log("条目       : " + stats.totalEntries + " (隐藏 shadow 已排除)");
  console.log("节点 / 边  : " + (graph.nodes as unknown[]).length + " / " + (graph.edges as unknown[]).length);
  console.log("孤立节点   : " + stats.orphanNodes);
  if (Number(stats.danglingEdges) > 0) console.log("悬空边     : " + stats.danglingEdges + " (" + stats.danglingNote + ")");
  if (stats.truncated) console.log("已截断     : 只渲染前 " + flags.max + " 条");
  if (skipped.length) console.log("解析警告   : " + skipped.length + " 条");
  console.log("输出       : " + flags.out);
  console.log("体积       : " + (Buffer.byteLength(html) / 1024).toFixed(1) + " KB");
  return 0;
}

process.exitCode = main(process.argv.slice(2));
