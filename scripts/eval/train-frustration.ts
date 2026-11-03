// scripts/eval/train-frustration.ts — 用标注样本选型并训练挫折检测器 (不调用任何模型, 离线, 可复现)。
//
// 做什么:
//   1. 读 tests/fixtures/eval/frustration/samples.jsonl (正例 = insult | correction | both)。
//   2. 4 个候选, 全部做嵌套分组交叉验证 (一组 = 一个会话; 外层 8 折, 阈值取内层 4 折的折外得分, 只对留出的会话打分):
//        A lexicon     现有词表 + 技术词豁免, 不训练 (基线);
//        B rules       lex + cue + shape 三组人写特征, 逻辑回归学权重 (纯规则加权);
//        C ngram       只用 2-3 元组哈希特征, 逻辑回归 (小模型);
//        D rules+ngram 两者合并。
//   3. 每个候选的留出预测做会话级 bootstrap (2000 次, seed 20261101), 给 recall / FPR 的 95% 区间;
//      按 choose() 的规则选一个, 在全部样本上重训, 写 src/frustration/model.ts。
//   3b. 后验口径 (离线, 不进模型): 选中候选的留出预测 OR 「下一条助手首句命中 POSTERIOR_CUES」, 单独报 recall / FPR,
//      输入是 tests/fixtures/eval/frustration/next-assistant.jsonl (scripts/eval/next-assistant-fixture.py 生成)。
//   4. 写 eval-out/train.json (每个候选的混淆矩阵、区间、逐条留出预测), 然后重生成 docs/eval-report.html。
//
// 用法: node --experimental-strip-types --no-warnings scripts/eval/train-frustration.ts [--set <dir>] [--out eval-out] [--no-write-model]
// 退出码: 0 已训练并写出; 2 样本无效 (缺文件 / 无正例或无负例); 3 运行出错。
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  bootstrapCI,
  confusion,
  crossValidate,
  DEFAULT_TRAIN,
  explain,
  fit,
  fitWithHonestThreshold,
  wilson,
  type LinearModel,
  type Prediction,
  type BootstrapCI,
  type TrainSample,
} from "../../src/frustration/classifier.ts";
import { extractPosteriorFeatures } from "../../src/frustration/features.ts";
import { compensateAtTurnEnd, createDetector, LEXICON_MODEL } from "../../src/frustration/detect.ts";
import type { FeatureGroups } from "../../src/frustration/features.ts";
import { writeReport } from "./report.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const arg = (name: string, d: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : d;
};

export const CANDIDATES: ReadonlyArray<{ id: string; name: string; groups: FeatureGroups | null; complexity: number; lexiconFloor?: boolean }> = [
  { id: "A", name: "lexicon (现有词表, 不训练)", groups: null, complexity: 0 },
  { id: "B", name: "rules (人写特征 + 学权重)", groups: { lex: true, cue: true, shape: true, ngram: false }, complexity: 1 },
  { id: "C", name: "ngram (2-3 元组 LR 小模型)", groups: { lex: false, cue: false, shape: false, ngram: true }, complexity: 2 },
  { id: "D", name: "rules + ngram", groups: { lex: true, cue: true, shape: true, ngram: true }, complexity: 3 },
  // 2026-11-01: B 的回归修复候选。同 B 的特征与权重, 外加词表兜底 (A 判中的必判中), 见 LinearModel.lexiconFloor。
  { id: "E", name: "rules + 词表兜底 (B ∪ A)", groups: { lex: true, cue: true, shape: true, ngram: false }, complexity: 1.5, lexiconFloor: true },
];

export interface CandidateResult {
  id: string;
  name: string;
  complexity: number;
  tp: number; fn: number; fp: number; tn: number;
  recall: number | null;
  fpr: number | null;
  recallCI: [number, number];
  boot: BootstrapCI;
  features: number | null;
  /** 回归句集 (regression.jsonl) 上的成绩: 用全量训练出的模型 (即会写进 model.ts 的那个) 判。 */
  regression: RegressionScore;
  preds: Prediction[];
}

export interface RegressionRow { id: string; text: string; expect: "hit" | "miss" | "open"; next_assistant_first?: string }
export interface RegressionScore { pass: number; total: number; hits: string[]; failed: string[]; lostVsA: string[] }

export function loadRegression(setDir: string): RegressionRow[] {
  const p = join(setDir, "regression.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}

/** 回归句判定: 实时 detect(), 带 next_assistant_first 的行再走 compensateAtTurnEnd (与 tests/frustration/model-regression.test.ts 同口径)。 */
export function scoreRegression(m: LinearModel, rows: readonly RegressionRow[], aHits?: ReadonlySet<string>): RegressionScore {
  const det = createDetector({ model: m });
  const hits: string[] = [], failed: string[] = [];
  let pass = 0, total = 0;
  for (const r of rows) {
    const rt = det.detect(r.text);
    const hit = r.next_assistant_first === undefined ? rt.hit : compensateAtTurnEnd(rt, r.next_assistant_first, m).hit;
    if (hit) hits.push(r.id);
    if (r.expect === "open") continue;
    total++;
    if (hit === (r.expect === "hit")) pass++;
    else failed.push(r.id);
  }
  const lostVsA = aHits ? [...aHits].filter((id) => !hits.includes(id)) : [];
  return { pass, total, hits, failed, lostVsA };
}

/** FPR 目标 (EVAL A2)。 */
export const FPR_TARGET = 0.05;

/**
 * 选型规则 (2026-11-02 第三版, 严格门限; 用户指定, 取代 11-01 第二版的「FPR 区间覆盖 0.05 即保留」):
 *   0. 回归门槛: 回归句通过数少于 A、或丢了任何一条 A 判中的回归句 ⇒ 淘汰。
 *   1. 留出 FPR **点估计** > 0.05 (EVAL A2) ⇒ 淘汰。bootstrap 区间只作报告, 不作豁免。
 *   2. 保留者按留出召回 (点估计) 从高到低排, 取第一; 召回相同取 FPR 低者, 再相同取更简单者。
 *   3. 全部被淘汰时写明「无候选达标」, 线上回退到现有词表 A (不训练), 不把任何超阈值的候选上线。
 */
export function choose(rs: readonly CandidateResult[]): { id: string; why: string; ranking: string[]; excluded: string[]; qualified: boolean } {
  const ci = (r: CandidateResult) => `[${r.boot.fpr[0].toFixed(3)}, ${r.boot.fpr[1].toFixed(3)}]`;
  const a = rs.find((r) => r.id === "A");
  const regFail = (r: CandidateResult) =>
    r.regression.total > 0 && a && r.id !== "A" && (r.regression.pass < a.regression.pass || r.regression.lostVsA.length > 0);
  const regOut = rs.filter(regFail);
  const fprOut = rs.filter((r) => !regOut.includes(r) && (r.fpr ?? 1) > FPR_TARGET);
  const ok = rs.filter((r) => !fprOut.includes(r) && !regOut.includes(r));
  const excluded = [
    ...regOut.map((r) => `${r.id} (回归句 ${r.regression.pass}/${r.regression.total} < A ${a!.regression.pass}/${a!.regression.total}` + (r.regression.lostVsA.length ? `, 丢了 A 判中的 ${r.regression.lostVsA.join("/")}` : "") + ")"),
    ...fprOut.map((r) => `${r.id} (FPR 点估计 ${r.fpr?.toFixed(3)} > ${FPR_TARGET}, 区间 ${ci(r)} 不作豁免)`),
  ];
  if (!ok.length) {
    return { id: "A", why: `无候选达标 (没有候选的 FPR 点估计 <= ${FPR_TARGET} 且过回归门槛); 线上回退到现有词表 A, 这不是达标; 淘汰: ${excluded.join(", ")}`, ranking: [], excluded, qualified: false };
  }
  const ranked = [...ok].sort((x, y) => (y.recall ?? 0) - (x.recall ?? 0) || (x.fpr ?? 1) - (y.fpr ?? 1) || x.complexity - y.complexity);
  const top = ranked[0]!;
  const ranking = ranked.map((r) => `${r.id} 回归 ${r.regression.pass}/${r.regression.total} 召回 ${r.recall?.toFixed(3)} [${r.boot.recall[0].toFixed(3)}, ${r.boot.recall[1].toFixed(3)}] FPR ${r.fpr?.toFixed(3)} ${ci(r)}`);
  return {
    id: top.id,
    why: `FPR 点估计 <= ${FPR_TARGET} 且过回归门槛的候选按留出召回排序, ${top.id} 最高 (召回 ${top.recall?.toFixed(3)}, FPR ${top.fpr?.toFixed(3)} ${ci(top)})` +
      (excluded.length ? `; 淘汰: ${excluded.join(", ")}` : "; 无候选被淘汰"),
    ranking,
    excluded,
    qualified: true,
  };
}

export function loadSamples(setDir: string): { samples: TrainSample[]; sha: string } {
  const raw = readFileSync(join(setDir, "samples.jsonl"), "utf8");
  const samples = raw
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))
    .map((s) => ({
      id: String(s.sid),
      group: String(s.source?.session ?? s.sid),
      text: String(s.text ?? ""),
      y: (s.label === "none" ? 0 : 1) as 0 | 1,
      prevAssistant: String(s.prev_assistant ?? ""),
    }));
  const nextPath = join(setDir, "next-assistant.jsonl");
  if (existsSync(nextPath)) {
    const next = new Map(
      readFileSync(nextPath, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)).map((r) => [String(r.sid), String(r.next_assistant_first ?? "")] as const),
    );
    for (const s of samples) (s as TrainSample).nextAssistantFirst = next.get(s.id) ?? "";
  }
  return { samples, sha: createHash("sha256").update(raw).digest("hex").slice(0, 16) };
}

export function runCandidates(samples: readonly TrainSample[], reg: readonly RegressionRow[] = []): CandidateResult[] {
  const results: CandidateResult[] = [];
  const aHits = new Set(scoreRegression(LEXICON_MODEL, reg).hits);
  for (const c of CANDIDATES) {
    let preds: Prediction[];
    let features: number | null = null;
    if (!c.groups) {
      const det = createDetector({ model: LEXICON_MODEL });
      preds = samples.map((s) => {
        const sig = det.detect(s.text);
        return { id: s.id, group: s.group, y: s.y, hit: sig.hit, score: sig.score ?? 0, threshold: sig.threshold ?? 1, fold: "none" };
      });
    } else {
      const o = { ...DEFAULT_TRAIN, groups: c.groups };
      preds = crossValidate(samples, o);
      if (c.lexiconFloor) {
        // 兜底不学参数, 所以对留出预测直接 OR 词表命中即可, 不泄漏。
        const lexHit = new Map(samples.map((s) => [s.id, explain(LEXICON_MODEL, s.text).hit]));
        preds = preds.map((p) => ({ ...p, hit: p.hit || !!lexHit.get(p.id) }));
      }
      features = Object.keys(fit(samples, o).weights).length;
    }
    // 回归句用「会写进 model.ts 的那个模型」判: A 用词表, 其余用全量 + 诚实阈值训练 (+ 兜底标记)。
    const full: LinearModel = c.groups ? fitWithHonestThreshold(samples, { ...DEFAULT_TRAIN, groups: c.groups }, 4) : LEXICON_MODEL;
    if (c.lexiconFloor) full.lexiconFloor = true;
    const regression = scoreRegression(full, reg, c.id === "A" ? undefined : aHits);
    const cm = confusion(preds);
    results.push({ id: c.id, name: c.name, complexity: c.complexity, ...cm, recallCI: wilson(cm.tp, cm.tp + cm.fn), boot: bootstrapCI(preds), features, regression, preds });
  }
  return results;
}

function main(): number {
  const setDir = resolve(REPO, arg("--set", "tests/fixtures/eval/frustration"));
  const outDir = resolve(REPO, arg("--out", "eval-out"));
  if (!existsSync(join(setDir, "samples.jsonl"))) {
    console.error("缺少 " + join(setDir, "samples.jsonl"));
    return 2;
  }
  const { samples, sha } = loadSamples(setDir);
  if (!samples.some((s) => s.y === 1) || !samples.some((s) => s.y === 0)) {
    console.error("样本里必须同时有正例和负例");
    return 2;
  }
  const reg = loadRegression(setDir);
  const results = runCandidates(samples, reg);
  const pick = choose(results);
  const literalUpper = results.filter((r) => r.boot.fpr[1] <= FPR_TARGET).map((r) => r.id);
  // 后验口径 (离线): 只在留出预测之上 OR 后验特征, 不训练, 不进 model.ts。
  const nextOf = new Map(samples.map((s) => [s.id, s.nextAssistantFirst ?? ""]));
  const posterior = results.map((r) => {
    const preds = r.preds.map((p) => ({ ...p, hit: p.hit || extractPosteriorFeatures(nextOf.get(p.id) ?? "").size > 0 }));
    const cm = confusion(preds);
    const added = preds.filter((p, i) => p.hit && !r.preds[i]!.hit).map((p) => p.id);
    return { id: r.id, ...cm, boot: bootstrapCI(preds), addedHits: added };
  });
  const chosen = CANDIDATES.find((c) => c.id === pick.id)!;
  let modelInfo: Record<string, unknown> = { id: pick.id, groups: chosen.groups };
  if (!process.argv.includes("--no-write-model")) {
    const m: LinearModel = chosen.groups
      ? fitWithHonestThreshold(samples, { ...DEFAULT_TRAIN, groups: chosen.groups }, 4)
      : { ...LEXICON_MODEL, meta: { ...LEXICON_MODEL.meta } };
    if (chosen.lexiconFloor) m.lexiconFloor = true;
    m.meta = { ...m.meta, candidate: pick.id, samplesSha256: sha, trainedBy: "scripts/eval/train-frustration.ts" };
    const body =
      "// src/frustration/model.ts — 由 scripts/eval/train-frustration.ts 生成, 不要手改 (改了下次训练会被覆盖)。\n" +
      "// 重新生成: node --experimental-strip-types --no-warnings scripts/eval/train-frustration.ts\n" +
      "// 选型: " + pick.why.replace(/\n/g, " ") + "\n" +
      'import type { LinearModel } from "./classifier.ts";\n\n' +
      "export const MODEL: LinearModel = " + JSON.stringify(m, null, 2) + ";\n";
    writeFileSync(join(REPO, "src/frustration/model.ts"), body);
    modelInfo = { ...modelInfo, bias: m.bias, threshold: m.threshold, features: Object.keys(m.weights).length, weights: m.weights };
  }
  mkdirSync(outDir, { recursive: true });
  const out = {
    metric: "train",
    generatedAt: new Date().toISOString(),
    samples: { n: samples.length, pos: samples.filter((s) => s.y === 1).length, sessions: new Set(samples.map((s) => s.group)).size, sha256: sha },
    protocol: "nested grouped CV by session: outer 8 folds, threshold from inner 4-fold out-of-fold scores at FPR <= 0.05; CIs: session-cluster bootstrap 2000x seed 20261101, percentile 95%",
    selectionRule: "strict: exclude iff holdout FPR point estimate > 0.05 or regression gate fails; bootstrap CI reported only, never an exemption; rank kept by holdout recall; if none kept: no candidate qualified, fall back to lexicon A",
    literalUpperRuleSurvivors: literalUpper,
    regressionUsedForSelection: true, // 回归句在选型时作硬门槛, 其成绩不是独立证据 (EVAL-CRITIQUE 第 1 节)
    nextAssistantSamplesWithFirstText: samples.filter((s) => (s.nextAssistantFirst ?? "") !== "").length,
    posterior,
    hyper: DEFAULT_TRAIN,
    candidates: results,
    chosen: pick,
    model: modelInfo,
  };
  writeFileSync(join(outDir, "train.json"), JSON.stringify(out, null, 2) + "\n");
  for (const r of results) {
    console.log(`${r.id} ${r.name}: recall ${r.recall?.toFixed(3)} boot[${r.boot.recall.map((v) => v.toFixed(3)).join(", ")}]  fpr ${r.fpr?.toFixed(3)} boot[${r.boot.fpr.map((v) => v.toFixed(3)).join(", ")}]  TP${r.tp} FN${r.fn} FP${r.fp} TN${r.tn}  回归 ${r.regression.pass}/${r.regression.total}` + (r.regression.failed.length ? ` 未过 ${r.regression.failed.join(",")}` : "") + (r.regression.lostVsA.length ? ` 丢A ${r.regression.lostVsA.join(",")}` : ""));
  }
  for (const p of posterior) {
    console.log(`posterior ${p.id}: recall ${p.recall?.toFixed(3)} boot[${p.boot.recall.map((v) => v.toFixed(3)).join(", ")}]  fpr ${p.fpr?.toFixed(3)} boot[${p.boot.fpr.map((v) => v.toFixed(3)).join(", ")}]  TP${p.tp} FN${p.fn} FP${p.fp} TN${p.tn}  added ${p.addedHits.length}`);
  }
  console.log("注意: 回归句集 (regression.jsonl, 16 条, 来源 user-2026-11-01) 在选型时作硬门槛用过, 上面的「回归 x/15」不是独立证据 (EVAL-CRITIQUE 第 1 节)");
  console.log("字面规则 (上界 <= 0.05) 存活: " + (literalUpper.join(",") || "无"));
  console.log("选型: " + pick.id + " — " + pick.why);
  writeReport(REPO);
  return 0;
}

if (import.meta.url === "file://" + process.argv[1]) {
  try {
    process.exitCode = main();
  } catch (e) {
    console.error(e);
    process.exitCode = 3;
  }
}
