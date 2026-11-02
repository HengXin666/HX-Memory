// scripts/panel-detect.ts — HX-Memory 面板后端的一部分 (2026-11-02 从 panel-server.ts 按职责拆出, verify-structure 400 行约束)。
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
import { EVAL_DIR, REPO, readJson } from "./panel-ctx.ts";
import { type Entry, entries } from "./panel-state.ts";

export const DETECTORS = { current: createDetector({ model: MODEL }), lexicon: createDetector({ model: LEXICON_MODEL }) };
export function detectOne(model: LinearModel, det: (typeof DETECTORS)["current"], text: string, next?: string) {
  const rt = det.detect(text);
  const ex = explain(model, text);
  const feats = [...extractFeatures(text, model.groups).keys()].map((f) => ({ feature: f, weight: model.weights[f] ?? 0, floor: !!model.lexiconFloor && f.startsWith("lex:") && ["lex:blame-method", "lex:blame-execution", "lex:correction"].includes(f) }));
  feats.sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight) || a.feature.localeCompare(b.feature));
  const post = next ? compensateAtTurnEnd(rt, next, model) : null;
  return {
    model: model.version,
    candidate: (model.meta as Record<string, unknown> | undefined)?.candidate ?? null,
    bias: model.bias,
    threshold: model.threshold,
    lexiconFloor: !!model.lexiconFloor,
    score: ex.score,
    hit: rt.hit,
    via: rt.hit ? rt.via : null,
    kinds: rt.kinds,
    matched: rt.matched,
    features: feats,
    posterior: post ? { hit: post.hit, via: post.hit ? post.via : null, score: post.score, compensated: (post as { compensated?: boolean }).compensated ?? null } : null,
  };
}
export const detect = (text: string, next?: string) => ({ current: detectOne(MODEL, DETECTORS.current, text, next), lexicon: detectOne(LEXICON_MODEL, DETECTORS.lexicon, text, next) });

export function regressionLive() {
  const rows = (readFileSync(join(REPO, "tests/fixtures/eval/frustration/regression.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) as Array<{ id: string; text: string; expect: string; next_assistant_first?: string }>);
  return rows.map((r) => {
    const d = detect(r.text, r.next_assistant_first);
    const cur = d.current.posterior ?? d.current;
    const lex = d.lexicon.posterior ?? d.lexicon;
    const pass = r.expect === "open" ? !lex.hit || cur.hit : cur.hit === (r.expect === "hit");
    return { id: r.id, text: r.text, next: r.next_assistant_first ?? "", expect: r.expect, currentHit: cur.hit, via: cur.via, score: d.current.score, lexiconHit: lex.hit, pass };
  });
}

// ---------- 时间 × 置信度 (src/kernel/temporal.ts) ----------
/**
 * 时间衰减页的数据
 * .agents/notes/implemented/feature/2026-11-01-temporal-confidence-decay.md
 */
export function decayView(project: string) {
  const now = new Date().toISOString();
  const live = entries().filter((e) => (e.status ?? "active") === "active" && e.kind !== "doc");
  const normative = live.filter((e) => NORMATIVE_KINDS.has(e.kind));
  const sup = supersedeByRecency(normative);
  const byId = new Map(live.map((e) => [e.id, e]));
  const rows = normative
    .map((e) => {
      const s = sup.get(e.id);
      return { id: e.id, kind: e.kind, project: e.project ?? "", scope: e.scope, assertedAt: new Date(now).getTime() - ageDaysOf(e, now) * 864e5, ageDays: +ageDaysOf(e, now).toFixed(1), retention: +retentionOf(e, now).toFixed(3), confidence0: e.confidence ?? 0.7, effective: +effectiveConfidence(e, now, !!s).toFixed(3), supersededBy: s ? { id: s.by, overlap: s.overlap, text: String(byId.get(s.by)?.content ?? "").slice(0, 120) } : null, reinforcement: e.reinforcement ?? 0, text: e.content.slice(0, 200) };
    })
    .sort((a, b) => b.effective - a.effective);
  // 每条记忆真算一遍 (2026-11-01, 用户: "时间衰减页要真算给每条记忆打分, 不是静态说明"):
  // 断言日期 / 距今天数 / 半衰期 / 地板 / 保持率 R / 初始置信度 / 是否被同话题新条目压住 / 最终分 = confidence₀ × R × (被压 ? 0.1 : 1)。
  // 范围: 全部 active 的对话沉淀 (doc 不衰减, 不列)。同一套函数就是线上排序与常驻注入用的 (src/kernel/temporal.ts)。
  const scored = live
    .map((e) => {
      const s = sup.get(e.id);
      const age = ageDaysOf(e, now);
      const p = DECAY[e.kind];
      const q = qualityOf(e);
      return {
        id: e.id,
        kind: e.kind,
        project: e.project ?? "",
        assertedAt: new Date(new Date(now).getTime() - age * 864e5).toISOString(),
        ageDays: +age.toFixed(1),
        halfLifeDays: Number.isFinite(p.halfLifeDays) ? p.halfLifeDays : null,
        floor: p.floor,
        retention: +retentionOf(e, now).toFixed(3),
        confidence0: e.confidence ?? 0.7,
        superseded: !!s,
        score: +effectiveConfidence(e, now, !!s).toFixed(3),
        origin: q.origin,
        originLabel: q.originLabel,
        text: e.content.slice(0, 160),
      };
    })
    .sort((a, b) => b.score - a.score);
  const lineage = project ? [project] : undefined;
  const opts = { ...(lineage ? { lineage } : {}), budgetTokens: 400, estimate: estimateTokens };
  const before = selectAlwaysOnDetailed(live, opts);
  const after = selectAlwaysOnDetailed(live, { ...opts, now });
  const brief = (e: Entry) => ({ id: e.id, kind: e.kind, ageDays: +ageDaysOf(e, now).toFixed(1), retention: +retentionOf(e, now).toFixed(3), text: e.content.slice(0, 140) });
  // 「昨天定的 vs 去年定的」: 同 kind 同 importance 的两条规则, 只差断言时间。
  const pair = [1, 7, 30, 90, 365].map((d) => ({ ageDays: d, rule: +retention(d, DECAY.rule).toFixed(3), decision: +retention(d, DECAY.decision).toFixed(3), preference: +retention(d, DECAY.preference).toFixed(3) }));
  return {
    now,
    params: (Object.keys(DECAY) as Array<keyof typeof DECAY>).map((k) => ({ kind: k, halfLifeDays: DECAY[k].halfLifeDays, floor: DECAY[k].floor, normative: NORMATIVE_KINDS.has(k) })),
    curve: decayCurve([0, 1, 2, 3, 5, 7, 10, 14, 21, 30, 45, 60, 90, 120, 180, 270, 365]),
    supersede: { strong: TOPIC_STRONG, overlap: TOPIC_OVERLAP, factor: SUPERSEDED_FACTOR, count: sup.size },
    pair,
    derivation: readJson(join(EVAL_DIR, "decay-derivation.json")),
    rows,
    scored,
    alwaysOn: {
      project: project || null,
      before: before.entries.map(brief),
      after: after.entries.map(brief),
      superseded: after.blocked.filter((b) => b.reason === "superseded").map((b) => ({ id: b.id, kind: b.kind, by: b.supersededBy ?? "", text: b.content.slice(0, 140) })),
    },
  };
}

