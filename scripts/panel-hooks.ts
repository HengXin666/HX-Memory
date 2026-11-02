// scripts/panel-hooks.ts — HX-Memory 面板后端的一部分 (2026-11-02 从 panel-server.ts 按职责拆出, verify-structure 400 行约束)。
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
import { DSH_HOME, MEMORY_ROOT, PLUGIN_CLOSE_NOTE, ageHours, iso, loadConfig, parseAt } from "./panel-ctx.ts";
import { entries, external } from "./panel-state.ts";
import { detect } from "./panel-detect.ts";

export function readLedger(dir: string, n: number): Array<Record<string, unknown>> {
  let names: string[] = [];
  try { names = readdirSync(dir).filter((x) => x.endsWith(".jsonl")).sort(); } catch { return []; }
  const out: Array<Record<string, unknown>> = [];
  for (const name of names.reverse()) {
    const lines = readFileSync(join(dir, name), "utf8").trim().split("\n").filter(Boolean);
    for (const l of lines.reverse()) {
      try { out.push(JSON.parse(l)); } catch { /* 坏行跳过 */ }
      if (out.length >= n) return out;
    }
  }
  return out;
}
export function ledgerCount(dir: string): { files: number; lines: number } {
  let files = 0;
  let lines = 0;
  try {
    for (const x of readdirSync(dir)) {
      if (!x.endsWith(".jsonl")) continue;
      files++;
      lines += readFileSync(join(dir, x), "utf8").split("\n").filter(Boolean).length;
    }
  } catch { /* 没有该目录 */ }
  return { files, lines };
}
/** ~/.dsh/settings.yaml 里 hx-memory: 段的一层 key: value (没有该段 = 全用默认值)。只读, 不解析别的段 (那里有凭据)。 */
export function dshSettings(): { file: string; found: boolean; values: Record<string, string> } {
  const file = join(DSH_HOME, "settings.yaml");
  const values: Record<string, string> = {};
  let found = false;
  try {
    let inside = false;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (/^\S/.test(line)) { inside = /^["']?hx-memory["']?\s*:/.test(line); found ||= inside; continue; }
      const m = inside ? /^ {2}([A-Za-z][\w]*):\s*(.*?)\s*$/.exec(line) : null;
      if (m) values[m[1]!] = m[2]!;
    }
  } catch { /* 没有 settings.yaml */ }
  return { file, found, values };
}
export const SWITCH_DEFAULTS: Record<string, string> = { autoCapture: "true", injectBindings: "true", injectGuidance: "true", injectMode: "every-turn", autoEvolve: "true", decisionGate: "false", captureEpisodes: "true" };
/**
 * 插件是否被宿主选入 (根因见 COLLECT-BROKEN.md): 插件不在进程里时它自己什么也报告不了,
 * 只能从外面读 profile 清单。"依赖在、未选入" = 插件管理器的「关闭」语义, 重启后静默失效。
 */
export function pluginSelection() {
  const profile = process.env.HX_DSH_PROFILE?.trim() || "web";
  const file = join(DSH_HOME, "profiles", profile, "package.json");
  const name = "@hengxin666/hx-memory";
  try {
    const p = JSON.parse(readFileSync(file, "utf8"));
    const bundles: string[] = p?.dsh?.profile?.bundles ?? [];
    const deps = { ...(p.dependencies ?? {}), ...(p.devDependencies ?? {}) };
    return { profile, file, installed: name in deps, spec: deps[name] ?? null, selected: bundles.includes(name), error: "" };
  } catch (e) {
    return { profile, file, installed: false, spec: null, selected: false, error: String(e) };
  }
}
export function hooks(n = 20) {
  const settings = dshSettings();
  const switches = [
    ...Object.entries(SWITCH_DEFAULTS).map(([k, d]) => ({ key: k, value: settings.values[k] ?? d, from: settings.values[k] !== undefined ? "settings.yaml hx-memory." + k : "默认值 (src/adapters/dsh/settings.ts)" })),
    { key: "HX_FRUSTRATION_PIPELINE", value: process.env.HX_FRUSTRATION_PIPELINE?.trim() === "0" ? "off" : "on", from: process.env.HX_FRUSTRATION_PIPELINE ? "面板进程环境" : "未设 = 默认启用 (frustration-wiring.ts)" },
    { key: "HX_EXTERNAL_HOST", value: process.env.HX_EXTERNAL_HOST?.trim() === "1" ? "on" : "off", from: process.env.HX_EXTERNAL_HOST ? "面板进程环境" : "未设 = 默认关闭 (external-bridge.ts)" },
  ];
  const sched = readLedger(join(MEMORY_ROOT, "schedule"), n);
  const cap = readLedger(join(MEMORY_ROOT, "capture"), n);
  const reviewFile = (rel: string) => {
    try { return readFileSync(join(MEMORY_ROOT, rel), "utf8").trim().split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) as Array<Record<string, any>>; } catch { return []; }
  };
  const rq = reviewFile("review/queue.jsonl");
  const rc = reviewFile("review-capture/queue.jsonl");
  const reviews = [
    ...rq.map((r) => ({ queue: "review (规则提案)", id: r.id, at: r.proposal?.generatedAt ?? r.at ?? "", atMs: parseAt(r.proposal?.generatedAt ?? r.at), status: r.status ?? "", text: String(r.proposal?.rule ?? r.text ?? "").slice(0, 200) })),
    ...rc.map((r) => ({ queue: "review-capture (捕获复核)", id: r.id, at: r.at ?? "", atMs: parseAt(r.at), status: (r.reasons ?? []).join("; ").slice(0, 120), text: String(r.conclusion ?? r.question ?? "").slice(0, 200) })),
  ].sort((a, b) => b.atMs - a.atMs).slice(0, n);
  const lastPre = parseAt(sched[0]?.at);
  const lastCap = parseAt(cap[0]?.at);
  const lastRev = reviews[0]?.atMs ?? 0;
  const latest = Math.max(lastPre, lastCap);
  const plugin = pluginSelection();
  const fresh = !!latest && Date.now() - latest < 24 * 36e5;
  // 三种状态分开 (2026-11-01, 用户裁决): 已关闭是**用户的选择**, 标灰写原因, 不报警;
  // 只有「选入了却没数据」才是异常。根因与证据见 COLLECT-BROKEN.md。
  const state: "enabled-active" | "closed-by-user" | "enabled-no-data" | "not-installed" | "unknown" = plugin.error
    ? "unknown"
    : !plugin.installed
      ? "not-installed"
      : !plugin.selected
        ? "closed-by-user"
        : fresh ? "enabled-active" : "enabled-no-data";
  const closeNote = loadConfig().pluginCloseNote ?? PLUGIN_CLOSE_NOTE;
  const pluginVerdict = {
    "enabled-active": "已启用且在采集 (24 小时内有 pre-step/入库记录)",
    "closed-by-user": "已关闭 (用户主动): " + closeNote + "。依赖仍在, 未在 dsh.profile.bundles 中; 重新启用: bash scripts/capture-repair.sh 后重启 DSH",
    "enabled-no-data": "异常: 已选入 dsh.profile.bundles, 但 24 小时内没有任何采集/注入记录 (DSH 尚未重启, 或插件加载失败; 看 ~/.dsh/logs/startup-*.log)",
    "not-installed": "未安装: profile 依赖里没有 @hengxin666/hx-memory",
    unknown: "读不到 profile 清单: " + plugin.error,
  }[state];
  const verdict = state === "closed-by-user"
    ? "已关闭 (用户主动), 不采集"
    : !latest ? "从未生效 (账本为空)" : fresh ? "生效中 (24 小时内有 pre-step/入库记录)" : `未生效: 最近一次记录在 ${ageHours(latest)} 小时前`;
  let hookFiles: string[] = [];
  try { hookFiles = readdirSync(join(DSH_HOME, "hooks")).filter((x) => !x.startsWith("__")); } catch { /* 无 */ }
  return {
    memoryRoot: MEMORY_ROOT,
    verdict,
    active: fresh && plugin.selected,
    plugin: { ...plugin, state, closeNote: state === "closed-by-user" ? closeNote : "", lastCapture: iso(lastCap), lastCaptureAgeHours: ageHours(lastCap), verdict: pluginVerdict },
    switches,
    settingsFile: settings.file,
    settingsSectionFound: settings.found,
    dshHookFiles: hookFiles,
    ledgers: {
      preStep: { dir: "schedule/", ...ledgerCount(join(MEMORY_ROOT, "schedule")), last: iso(lastPre), ageHours: ageHours(lastPre) },
      capture: { dir: "capture/", ...ledgerCount(join(MEMORY_ROOT, "capture")), last: iso(lastCap), ageHours: ageHours(lastCap) },
      review: { dir: "review/queue.jsonl + review-capture/queue.jsonl", files: 2, lines: rq.length + rc.length, last: iso(lastRev), ageHours: ageHours(lastRev) },
    },
    preStep: sched.map((r) => ({ at: iso(parseAt(r.at)), session: String(r.session ?? "").slice(-8), project: r.project ?? "", step: r.step, channel: r.channel, mode: r.mode, outcome: r.outcome, ids: (r.ids as unknown[] | undefined)?.length ?? 0, tokens: r.tokens, reason: String(r.reason ?? "").slice(0, 160) })),
    capture: cap.map((r) => ({ at: iso(parseAt(r.at)), session: String(r.session ?? "").slice(-8), project: r.project ?? "", turn: r.turn, outcome: r.outcome, skip: r.skip ?? "", entries: r.entries, totalMs: r.totalMs })),
    reviews: reviews.map(({ atMs, ...r }) => ({ ...r, at: iso(atMs) })),
  };
}

// ---------- 检测 (同一个 detect, 只换 model) ----------
