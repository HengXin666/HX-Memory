// scripts/panel-server.ts — HX-Memory 面板: 一个进程同时出 API 和前端 (127.0.0.1:36100, 经 HX-WebX /proxy/hx-memory-panel/ 访问)。
//
// 每个页面上的数都来自下面某个真实读取路径, 不另造一套记忆实现:
//   概览   ← eval-out/*.json (15 个指标, 目录与达标判定 = scripts/eval/report.ts 的 CATALOG / stateOf)
//            + 记忆根 (openMemoryStack 的 store.all(); 规则 = kind:"rule" 条目 + <root>/rules/*.md 文件数)
//   记忆   ← store.all() 按 project/scope 分 bank; <root>/external/banks/*/bundle.json (CanonicalStore) 也列出;
//            搜索 = facade.recall (与线上同一个混合检索器, 语义通道关闭, 会标 degraded)
//   知识库 ← walkMarkdown(源目录) 的真实文件清单 × 库里 kind:"doc" 条目 (source kb:… / kb:@ns/…);
//            增量路径 = KbSync({ namespace }) 一轮 syncOnce, 只写自己命名空间, 不会删主语料 (见 src/kb/kb-sync.ts)
//   检测   ← src/frustration/detect.ts 的 createDetector + explain (与 tests/frustration/model-regression.test.ts 同一路径);
//            hook 状态 ← <root>/schedule|capture|review|review-capture 账本 + ~/.dsh/settings.yaml 的 hx-memory 段 + 进程环境
//   模型   ← <配置目录>/panel.json; api_key 只存 AES-256-GCM 密文, 或只存环境变量名
//
// 前端: 优先 scripts/panel.dist.html (预构建的单文件, 随仓库走, 起服务不需要 vite);
//       没有时退回 .tmp/panel/dist (bash scripts/panel.sh build 的产物)。
//
// 用法: node --experimental-strip-types --no-warnings scripts/panel-server.ts [--port 36100]
// 环境: HX_MEMORY_ROOT (默认 ~/.dsh/hx-memory)  HX_PANEL_CONFIG_DIR (默认 ~/.config/hx-memory-panel)
//       HX_PANEL_SECRET (可选主密钥, 不落盘)  HX_KB_ROOT (主语料根, 默认取 eval-out/K3.json 的 src)
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
import { CONFIG_DIR, CONFIG_FILE, DIST, EVAL_DIR, HOST, KB_NOTE, type KbSource, MEMORY_ROOT, PORT, SINGLE_FILE, STARTED, body, iso, loadConfig, parseAt, readJson, saveConfig, send, serveStatic } from "./panel-ctx.ts";
import { type Entry, bankOfEntry, entries, external, getStack, purgeJobOf, retrievalMode, stackErrorOf, startPurge } from "./panel-state.ts";
import { kbFiles, kbView, primarySource, runSync } from "./panel-kb.ts";
import { hooks } from "./panel-hooks.ts";
import { decayView, detect, regressionLive } from "./panel-detect.ts";
import { modelRoutes } from "./panel-model.ts";

function banks() {
  const m = new Map<string, { id: string; label: string; store: "main" | "external"; total: number; byStatus: Record<string, number>; byKind: Record<string, number> }>();
  const bump = (id: string, label: string, store: "main" | "external", status: string, kind: string) => {
    const b = m.get(id) ?? { id, label, store, total: 0, byStatus: {}, byKind: {} };
    b.total++;
    b.byStatus[status] = (b.byStatus[status] ?? 0) + 1;
    b.byKind[kind] = (b.byKind[kind] ?? 0) + 1;
    m.set(id, b);
  };
  for (const e of entries()) {
    if (e.kind === "doc") continue; // 知识库切片在知识库页
    bump(bankOfEntry(e), e.project ? "项目 " + e.project : e.scope === "global" ? "全局 global" : "代理 agent", "main", e.status ?? "active", e.kind);
  }
  try {
    const ext = external();
    for (const b of ext.listBanks()) {
      const rows = ext.listMemories(b);
      const superseded = new Set(rows.flatMap((r) => r.supersedes));
      for (const r of rows) bump("ext:" + b, "外置 " + b, "external", superseded.has(r.id) && r.status === "active" ? "superseded" : r.status, r.kind);
    }
  } catch { /* 没有外置 store */ }
  return [...m.values()].sort((a, b) => b.total - a.total);
}

interface Row { id: string; bank: string; kind: string; status: string; source: string; at: string | null; text: string; project?: string; scope?: string }
function rowsOf(bank: string): Row[] {
  if (bank.startsWith("ext:")) {
    const id = bank.slice(4);
    const rows = external().listMemories(id);
    const superseded = new Set(rows.flatMap((r) => r.supersedes));
    return rows.map((r) => ({ id: r.id, bank, kind: r.kind, status: superseded.has(r.id) && r.status === "active" ? "superseded" : r.status, source: "external:" + id, at: iso(parseAt(r.createdAt)), text: r.text }));
  }
  return entries()
    .filter((e) => e.kind !== "doc" && (!bank || bankOfEntry(e) === bank))
    .map((e) => ({ id: e.id, bank: bankOfEntry(e), kind: e.kind, status: e.status ?? "active", source: e.source, at: iso(parseAt(e.ts?.assertedAt)), text: e.content, project: e.project, scope: e.scope }));
}

// ---------- 知识库 ----------
function metrics() {
  let lastMs = 0;
  let lastFile = "";
  const rows = CATALOG.map((c) => {
    const f = join(EVAL_DIR, c.id + ".json");
    const j = readJson(f) ?? undefined;
    const st = stateOf(j);
    let at = 0;
    if (j) {
      at = parseAt(j.at) || statSync(f).mtimeMs;
      if (at > lastMs) { lastMs = at; lastFile = "eval-out/" + c.id + ".json"; }
    }
    return { id: c.id, name: c.name, group: c.group, threshold: c.threshold, blocker: !!c.blocker, script: "scripts/eval/" + c.script, state: st, stateText: STATE_TEXT[st], value: j?.value ?? null, n: j?.n ?? null, at: iso(at), file: j ? "eval-out/" + c.id + ".json" : null, invalidReasons: j?.invalidReasons ?? [] };
  });
  for (const extra of ["train.json", "detect-report.json", "len-feature-dist.json"]) {
    const f = join(EVAL_DIR, extra);
    if (!existsSync(f)) continue;
    const ms = statSync(f).mtimeMs;
    if (ms > lastMs) { lastMs = ms; lastFile = "eval-out/" + extra + " (mtime)"; }
  }
  const count = (s: string) => rows.filter((r) => r.state === s).length;
  return { rows, summary: { pass: count("pass"), fail: count("fail"), invalid: count("invalid"), untested: count("untested") }, lastEvalAt: iso(lastMs), lastEvalFile: lastFile };
}

// ---------- hook: 开关 + 执行记录 ----------
async function api(req: IncomingMessage, res: ServerResponse, path: string, url: URL) {
  const m = req.method ?? "GET";
  const q = (k: string) => url.searchParams.get(k)?.trim() ?? "";

  if (path === "health") return send(res, 200, { ok: true, service: "hx-memory-panel", port: PORT, pid: process.pid, startedAt: STARTED, memoryRoot: MEMORY_ROOT, model: MODEL.version });

  if (path === "overview" && m === "GET") {
    // 检索模式 (2026-11-02 FIX-ROUND-1): 面板的召回关掉了向量通道, 只剩 BM25 (词 / bigram 覆盖率)。
    // 线上 DSH 没设 HX_MEMORY_EMBEDDING_BASE_URL/MODEL 时, 向量通道用 LexicalEmbedder (词典 + 字级 n-gram), 也不是语义模型。
    // 两个池子分开计数 (2026-11-01 PANEL-FIX): 对话沉淀 = kind != doc; 知识库 = kind == doc。
    // 理由: 知识库切片是「可查的参考」, 不参与每轮注入 (src/trigger/always-on.ts:66「doc 显式排除」), 也不参与衰减 (src/kb/kb-sync.ts 头注 J2.5)。
    const all = entries();
    const pool = (list: Entry[]) => {
      const byKind: Record<string, number> = {};
      const byStatus: Record<string, number> = {};
      for (const e of list) {
        byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
        byStatus[e.status ?? "active"] = (byStatus[e.status ?? "active"] ?? 0) + 1;
      }
      return { total: list.length, byKind, byStatus };
    };
    const mem = all.filter((e) => e.kind !== "doc");
    const docs = all.filter((e) => e.kind === "doc");
    const docBySource: Record<string, number> = {};
    for (const e of docs) {
      const o = kbSourceNamespace(e.source);
      const k = !o ? "非 kb: 来源" : o.ns ? "增量 @" + o.ns : "主语料";
      docBySource[k] = (docBySource[k] ?? 0) + 1;
    }
    let ruleFiles = 0;
    try { ruleFiles = readdirSync(join(MEMORY_ROOT, "rules")).filter((x) => x.endsWith(".md")).length; } catch { /* 无 */ }
    const kb = kbView();
    const h = hooks(5);
    return send(res, 200, {
      ok: true,
      data: {
        retrieval: retrievalMode(),
        memoryRoot: MEMORY_ROOT,
        stackError: stackErrorOf(),
        stats: {
          dialog: { ...pool(mem), label: "对话沉淀", from: "store.all() 中 kind != doc" },
          kb: { ...pool(docs), label: "知识库", from: "store.all() 中 kind == doc", bySource: docBySource, files: kb.sources.reduce((a, s2) => a + s2.files, 0), ingestedFiles: kb.sources.reduce((a, s2) => a + s2.ingestedFiles, 0), filesFrom: "walkMarkdown(各来源) 的 .md 文件数" },
          rules: { entries: mem.filter((e) => e.kind === "rule").length, active: mem.filter((e) => e.kind === "rule" && (e.status ?? "active") === "active").length, files: ruleFiles, from: "kind:rule 条目 / <root>/rules/*.md 文件数" },
          all: all.length,
        },
        kbNote: KB_NOTE,
        metrics: metrics(),
        hook: { verdict: h.verdict, active: h.active, ledgers: h.ledgers, plugin: h.plugin },
        model: { version: MODEL.version, candidate: (MODEL.meta as Record<string, unknown>)?.candidate ?? null, threshold: MODEL.threshold },
      },
    });
  }

  if (path === "memory/recent" && m === "GET") {
    // 只查对话沉淀 (doc 不进), 并按「沉淀质量」分池 (2026-11-01, src/app/memory-quality.ts):
    //   pool=derived 推导出的沉淀 / pool=raw 用户原话 / pool=all 两者都要。每条带 quality (来源 / 是否提炼 / 长度)。
    const limit = Math.min(500, Math.max(1, Number(q("limit") || 30)));
    const pool = q("pool") || "all";
    const rows = entries()
      .filter((e) => e.kind !== "doc" && (e.status ?? "active") !== "shadow")
      .map((e) => ({ e, quality: qualityOf(e) }))
      .filter((x) => pool === "all" || x.quality.origin === pool)
      .sort((a, b) => parseAt(b.e.ts?.assertedAt) - parseAt(a.e.ts?.assertedAt))
      .slice(0, limit)
      .map(({ e, quality }) => ({ id: e.id, bank: bankOfEntry(e), kind: e.kind, status: e.status ?? "active", source: e.source, at: iso(parseAt(e.ts?.assertedAt)), text: e.content.slice(0, 220), quality }));
    return send(res, 200, { ok: true, data: { pool, excludes: "kind == doc", limit, items: rows } });
  }

  if (path === "memory/quality" && m === "GET") {
    // 「我怎么知道你沉淀的效果如何」的直接答案: 各类占比、原话占比、≤20 字低质条数、一句话结论, 外加两池各 5 条样例。
    const live = entries().filter((e) => (e.status ?? "active") !== "shadow");
    const summary = summarizeQuality(live);
    const sample = (origin: string) => live.filter((e) => e.kind !== "doc").map((e) => ({ e, qq: qualityOf(e) })).filter((x) => x.qq.origin === origin).sort((a, b) => parseAt(b.e.ts?.assertedAt) - parseAt(a.e.ts?.assertedAt)).slice(0, 5).map(({ e, qq }) => ({ id: e.id, kind: e.kind, text: e.content.slice(0, 120), why: qq.why }));
    return send(res, 200, { ok: true, data: { ...summary, kb: live.filter((e) => e.kind === "doc").length, criteria: { minLen: QUALITY_MIN_LEN, lowLen: LOW_QUALITY_LEN, rule: "context 只有两种情况算推导沉淀: (A) 内容就是结构化器给出的结论; (B) ≥40 字、带提炼结构词 (根因/起因/改为/结论/确认/判定/决定/导致/实测/而非…) 且「你/我」不超过 1 次。其余是用户原话: 不足 40 字 / 纯指令或附和 / 命令链接路径 / 对助手说话的口吻 / 无结构原文。lesson/decision/pattern/fact/preference/rule 一律算沉淀, doc 是知识库切片。" }, samples: { derived: sample("derived"), raw: sample("raw") } } });
  }


  if (path === "memory/banks" && m === "GET") return send(res, 200, { ok: true, data: { memoryRoot: MEMORY_ROOT, stackError: stackErrorOf(), banks: banks() } });

  if (path === "memory/list" && m === "GET") {
    const bank = q("bank");
    const status = q("status");
    const kind = q("kind");
    const text = q("q").toLowerCase();
    const offset = Math.max(0, Number(q("offset") || 0));
    const limit = Math.min(200, Math.max(1, Number(q("limit") || 50)));
    let rows = rowsOf(bank);
    if (status) rows = rows.filter((r) => r.status === status);
    if (kind) rows = rows.filter((r) => r.kind === kind);
    if (text) rows = rows.filter((r) => r.text.toLowerCase().includes(text) || r.id.toLowerCase().includes(text) || r.source.toLowerCase().includes(text));
    // 2026-11-02: list 也按沉淀质量分池 (pool=derived|raw|all), 每条带 quality, 与 memory/recent 同一判据 (qualityOf)。
    const qmap = new Map(bank.startsWith("ext:") ? [] : entries().map((e) => [e.id, qualityOf(e)] as const));
    const pool = q("pool") || "all";
    if (pool !== "all") rows = rows.filter((r) => qmap.get(r.id)?.origin === pool);
    rows.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    return send(res, 200, { ok: true, data: { total: rows.length, offset, pool, items: rows.slice(offset, offset + limit).map((r) => ({ ...r, text: r.text.slice(0, 220), quality: qmap.get(r.id) ?? null })) } });
  }

  if (path === "memory/search" && m === "GET") {
    // 结果按 kind 分组; doc 单独一组。excludeKb 默认 1 (全局开关「排除知识库」): 1 时不返回 doc, 只报被排除的条数。
    const text = q("q");
    const bank = q("bank");
    const excludeKb = q("excludeKb") !== "0";
    const s = getStack();
    if (!s) return send(res, 500, { ok: false, error: stackErrorOf() });
    if (!text) return send(res, 400, { ok: false, error: "q 不能为空" });
    if (embeddingSource(process.env, CONFIG_DIR).source !== "none") await s.retriever.warm(2000, text); // 真语义: 先补投影 (限时 2s, 未补完的下次继续)
    const r = s.facade.recall({ text, purpose: "recall" } as never);
    const hits = r.hits.filter((h) => !bank || bankOfEntry(h.entry as Entry) === bank).slice(0, 40);
    const shape = (h: (typeof hits)[number]) => ({ id: h.entry.id, bank: bankOfEntry(h.entry as Entry), kind: h.entry.kind, status: h.entry.status ?? "active", source: h.entry.source, score: h.score, channels: h.channels, why: h.why, text: String(h.entry.content ?? "").slice(0, 240) });
    const dialog = hits.filter((h) => h.entry.kind !== "doc").map(shape);
    const docHits = hits.filter((h) => h.entry.kind === "doc").map(shape);
    const groups: Record<string, ReturnType<typeof shape>[]> = {};
    for (const h of dialog) (groups[h.kind] ??= []).push(h);
    return send(res, 200, { ok: true, data: { via: "facade.recall (HybridRetriever)", degraded: r.degraded, tokens: r.tokens, excludeKb, groups, kb: excludeKb ? [] : docHits, kbExcluded: excludeKb ? docHits.length : 0, kbNote: KB_NOTE } });
  }

  if (path === "memory/entry" && m === "GET") {
    const id = q("id");
    const bank = q("bank");
    if (bank.startsWith("ext:")) {
      const r = external().getMemory(bank.slice(4), id);
      return r ? send(res, 200, { ok: true, data: { store: "external", file: join(MEMORY_ROOT, "external/banks", bank.slice(4), "bundle.json"), entry: r, related: [] } }) : send(res, 404, { ok: false, error: "没有这条" });
    }
    const all = entries();
    const e = all.find((x) => x.id === id);
    if (!e) return send(res, 404, { ok: false, error: "没有这条: " + id });
    const byId = new Map(all.map((x) => [x.id, x]));
    const related = (e.relations ?? []).map((r) => ({ type: r.type, toId: r.toId, kind: byId.get(r.toId)?.kind ?? null, status: byId.get(r.toId)?.status ?? (byId.has(r.toId) ? "active" : null), text: String(byId.get(r.toId)?.content ?? "").slice(0, 80) }));
    const incoming = all.filter((x) => x.id !== id && (x.relations ?? []).some((r) => r.toId === id)).slice(0, 20).map((x) => ({ type: (x.relations ?? []).find((r) => r.toId === id)!.type, fromId: x.id, kind: x.kind, status: x.status ?? "active", text: x.content.slice(0, 80) }));
    return send(res, 200, { ok: true, data: { store: "main", bank: bankOfEntry(e), entry: e, related, incoming } });
  }

  if (path === "kb" && m === "GET") return send(res, 200, { ok: true, data: kbView() });

  if (path === "kb/files" && m === "GET") {
    const files = kbFiles(q("root"));
    return files ? send(res, 200, { ok: true, data: { root: q("root"), files } }) : send(res, 404, { ok: false, error: "没有这个来源" });
  }

  if (path === "kb" && m === "POST") {
    // 增量加路径: 校验存在 → 加入配置 → 一轮 syncOnce (只写本路径的命名空间) → 回新增/更新/删除条数
    const b = await body(req);
    const root = String(b.root ?? "").trim().replace(/\/+$/, "");
    const dirs = (Array.isArray(b.dirs) ? b.dirs : String(b.dirs ?? "").split(",")).map((d) => String(d).trim()).filter(Boolean);
    const steps: Array<{ step: string; ok: boolean; detail: string }> = [];
    if (!isAbsolute(root)) return send(res, 400, { ok: false, error: "必须是绝对路径", steps: [{ step: "校验", ok: false, detail: "不是绝对路径: " + root }] });
    if (!existsSync(root) || !statSync(root).isDirectory()) return send(res, 400, { ok: false, error: "目录不存在", steps: [{ step: "校验", ok: false, detail: "目录不存在: " + root }] });
    if (root === primarySource().root) return send(res, 400, { ok: false, error: "这是主语料, 已经在列表里" });
    const useDirs = dirs.length ? dirs : ["."];
    const missing = useDirs.filter((d) => !existsSync(join(root, d)));
    if (missing.length) return send(res, 400, { ok: false, error: "子目录不存在: " + missing.join(", "), steps: [{ step: "校验", ok: false, detail: "子目录不存在: " + missing.join(", ") }] });
    const md = walkMarkdown(root, useDirs).length;
    steps.push({ step: "校验", ok: true, detail: `目录存在, ${md} 个 .md` });
    if (!md) return send(res, 400, { ok: false, error: "该路径下没有 .md 文件", steps });
    const cfg = loadConfig();
    const entry: KbSource = { root, dirs: useDirs, addedAt: new Date().toISOString() };
    cfg.kb = [...cfg.kb.filter((k) => k.root !== root), entry];
    saveConfig(cfg);
    steps.push({ step: "加入配置", ok: true, detail: CONFIG_FILE + " (命名空间 " + kbNamespace(root) + ")" });
    const report = runSync(entry, false);
    entry.lastSync = report;
    saveConfig(cfg);
    steps.push({ step: "syncOnce", ok: true, detail: `新增 ${report.added} / 更新 ${report.updated} / 删除 ${report.removed} / 未变 ${report.unchanged}, ${report.ms} ms` });
    return send(res, 200, { ok: true, data: { steps, report, kb: kbView() } });
  }

  if (path === "kb/sync" && m === "POST") {
    const b = await body(req);
    const root = String(b.root ?? "");
    const cfg = loadConfig();
    const prim = primarySource();
    if (root === prim.root) {
      if (!existsSync(prim.root)) return send(res, 400, { ok: false, error: "主语料目录不存在: " + prim.root });
      const report = runSync(prim, true);
      cfg.primaryLastSync = report;
      saveConfig(cfg);
      return send(res, 200, { ok: true, data: report });
    }
    const src = cfg.kb.find((k) => k.root === root);
    if (!src) return send(res, 404, { ok: false, error: "没有这个知识库来源" });
    src.lastSync = runSync(src, false);
    saveConfig(cfg);
    return send(res, 200, { ok: true, data: src.lastSync });
  }

  if (path === "kb/purge" && m === "GET") { const j = purgeJobOf(); return send(res, 200, { ok: true, data: { job: j, running: !!j && j.exit === undefined } }); }

  if (path === "kb/purge" && m === "DELETE") {
    // 二次确认: 前端要求手输确认词, 后端再校验一次 (防止任何别的调用方一条 DELETE 就清库)。
    const b = await body(req).catch(() => ({} as Record<string, unknown>));
    const word = String(b.confirm ?? q("confirm") ?? "");
    if (word !== "清空知识库") return send(res, 400, { ok: false, error: "需要确认词: 清空知识库" });
    { const j = purgeJobOf(); if (j && j.exit === undefined) return send(res, 409, { ok: false, error: "已有一次清空在跑 (pid " + j.pid + ")" }); }
    return send(res, 202, { ok: true, data: { job: startPurge() } });
  }

  if (path === "kb" && m === "DELETE") {
    const root = q("root");
    if (root === primarySource().root) return send(res, 400, { ok: false, error: "主语料不能从面板移除" });
    const cfg = loadConfig();
    cfg.kb = cfg.kb.filter((k) => k.root !== root);
    saveConfig(cfg);
    let purged = 0;
    if (q("purge") === "1") {
      const s = getStack();
      const ns = kbNamespace(root);
      for (const e of entries()) {
        if (e.kind === "doc" && kbSourceNamespace(e.source)?.ns === ns) { s!.store.remove(e.id); purged++; }
      }
    }
    return send(res, 200, { ok: true, data: { purged, kb: kbView() } });
  }

  if (path === "decay" && m === "GET") return send(res, 200, { ok: true, data: decayView(q("project")) });

  if (path === "hooks" && m === "GET") return send(res, 200, { ok: true, data: hooks(Math.min(100, Number(q("n") || 20))) });

  if (path === "detect" && m === "POST") {
    const b = await body(req);
    const text = String(b.text ?? "");
    if (!text.trim()) return send(res, 400, { ok: false, error: "text 不能为空" });
    return send(res, 200, { ok: true, data: detect(text, b.nextAssistant ? String(b.nextAssistant) : undefined) });
  }

  if (path === "eval" && m === "GET") {
    const train = readJson(join(EVAL_DIR, "train.json"));
    return send(res, 200, { ok: true, data: { regression: regressionLive(), candidates: (train?.candidates ?? []).map((c: any) => ({ id: c.id, name: c.name, recall: c.recall, fpr: c.fpr, boot: c.boot, tp: c.tp, fp: c.fp, fn: c.fn, tn: c.tn, regression: c.regression })), chosen: train?.chosen ? { id: train.chosen.id, why: train.chosen.why } : null, lenDist: readJson(join(EVAL_DIR, "len-feature-dist.json")), model: { version: MODEL.version, meta: MODEL.meta, threshold: MODEL.threshold } } });
  }

  if (path === "model" || path.startsWith("model/") || path === "embedding" || path.startsWith("embedding/")) return modelRoutes(req, res, path, m);

  return send(res, 404, { ok: false, error: "no route: " + m + " /api/" + path });
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  // HX-WebX 会剥掉 /proxy/<name>; 直连或经适配层时可能还带着, 两种都认。
  const p = url.pathname.replace(/^\/proxy\/[^/]+/, "");
  try {
    if (p.startsWith("/api/")) return await api(req, res, p.slice(5).replace(/\/+$/, ""), url);
    return serveStatic(p, res);
  } catch (e) {
    return send(res, 500, { ok: false, error: String(e) });
  }
}).listen(PORT, HOST, () => {
  console.log(`hx-memory panel: http://${HOST}:${PORT}/  memoryRoot=${MEMORY_ROOT} config=${CONFIG_FILE} ui=${existsSync(SINGLE_FILE) ? SINGLE_FILE : DIST}`);
});
