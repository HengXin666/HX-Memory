// scripts/eval/detect-report.ts — DETECT-REPORT.md 的数全部从这里出 (不调用模型, 离线, 可复现)。
//
// 1. 纯可观测规则 (候选 B: lex + cue + shape, 不含 ngram) 的 A1 分布: 嵌套分组 CV 换 50 种会话分折 (salt 0..49),
//    每种分折得一个留出 recall / FPR, 报分位数; 另报「训练集 = 测试集」的重代入 recall (乐观上界, 只作对照)。
// 2. 用 src/frustration/model.ts 的当前模型对一条真实漏判跑 explain(), 原样输出。
// 3. 过拟合: 特征数、每特征正例数 (EPV)、重代入 vs CV 的差; 合并折外得分的 AUC 与不同 FPR 下的 recall。
//
// 用法: node --experimental-strip-types --no-warnings scripts/eval/detect-report.ts [--sid f143,f121] [--splits 50] > eval-out/detect-report.json
// 退出码: 0 成功; 2 样本缺失; 3 运行出错。
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assignFolds, auc, confusion, crossValidate, DEFAULT_TRAIN, explain, fit, fitWithHonestThreshold, scoreVector, type LinearModel } from "../../src/frustration/classifier.ts";
import { extractFeatures } from "../../src/frustration/features.ts";
import { MODEL } from "../../src/frustration/model.ts";
import { loadSamples } from "./train-frustration.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const arg = (n: string, d: string) => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : d; };
const q = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1) + 0.5)))]!; };
const r4 = (v: number) => Math.round(v * 1e4) / 1e4;

function main(): number {
  const setDir = join(REPO, "tests/fixtures/eval/frustration");
  if (!existsSync(join(setDir, "samples.jsonl"))) return 2;
  const { samples, sha } = loadSamples(setDir);
  const groups = { lex: true, cue: true, shape: true, ngram: false };
  const o = { ...DEFAULT_TRAIN, groups };
  const splits = Number(arg("--splits", "50"));
  const runs: Array<{ salt: string; recall: number; fpr: number }> = [];
  let pooled: Array<{ score: number; margin: number; y: 0 | 1 }> = [];
  for (let k = 0; k < splits; k++) {
    const salt = k === 0 ? "" : String(k);
    const preds = crossValidate(samples, o, 8, 4, salt);
    const cm = confusion(preds);
    runs.push({ salt, recall: r4(cm.recall ?? 0), fpr: r4(cm.fpr ?? 0) });
    if (k === 0) pooled = preds.map((p) => ({ score: p.score, margin: p.score - p.threshold, y: p.y }));
  }
  const ps = [0, 0.05, 0.25, 0.5, 0.75, 0.95, 1];
  const quant = (key: "recall" | "fpr") => Object.fromEntries(ps.map((p) => ["p" + Math.round(p * 100), q(runs.map((r) => r[key]), p)]));
  // 重代入 (乐观上界): 全量训练, 阈值取训练集 FPR <= 0.05
  const full = fit(samples, o);
  const resub = confusion(samples.map((s) => ({ y: s.y, hit: scoreVector(full, extractFeatures(s.text, groups)) >= full.threshold })));
  // 不同 FPR 下的 recall (salt="" 那次的折外 margin 合并; 各折阈值不同, 用 margin = score - 折阈值 合并)
  const negM = pooled.filter((p) => p.y === 0).map((p) => p.margin).sort((a, b) => b - a);
  const posM = pooled.filter((p) => p.y === 1).map((p) => p.margin);
  const atFpr = Object.fromEntries([0.05, 0.1, 0.2, 0.3].map((f) => {
    const cut = negM[Math.floor(f * negM.length)]!;
    return ["fpr<=" + f, r4(posM.filter((m) => m > cut).length / posM.length)];
  }));
  // explain(): 每个 sid 跑两次 —— (a) 当前 model.ts (全量训练, 该条在训练集里, 属于样本内);
  // (b) 该条所在外层折的留出模型 (salt="", 与 train.json 的 B 留出预测同一个模型), 这才是「真实漏判」的口径。
  const outer = assignFolds(samples.map((x) => x.group), 8, "");
  const ex = (m: LinearModel, sid: string) => {
    const s = samples.find((x) => x.id === sid)!;
    const e = explain(m, s.text, s.prevAssistant ?? "");
    const fired = [...extractFeatures(s.text, m.groups, { prevAssistant: s.prevAssistant }).keys()];
    return { bias: m.bias, contributions: e.contributions, score: r4(e.score), threshold: e.threshold, hit: e.hit, gap: r4(e.threshold - e.score),
      firedWithoutWeight: fired.filter((f) => !(m.weights[f] ?? 0)) };
  };
  const sids = arg("--sid", "f143,f121").split(",");
  const q2 = sids.map((sid) => {
    const s = samples.find((x) => x.id === sid);
    if (!s) return { sid, error: "sid not found" };
    const f = outer.get(s.group)!;
    const heldModel = fitWithHonestThreshold(samples.filter((x) => outer.get(x.group) !== f), o, 4);
    return { sid, y: s.y, text: s.text, outerFold: f,
      currentModel: { id: `${MODEL.version}/${MODEL.meta.candidate}/${MODEL.meta.samplesSha256}`, inSample: true, ...ex(MODEL, sid) },
      heldOutModel: { trainedWithout: "outer fold " + f, ...ex(heldModel, sid) } };
  });
  const posFeat = Object.keys(MODEL.weights).length;
  const nPos = samples.filter((x) => x.y === 1).length;
  console.log(JSON.stringify({
    samples: { n: samples.length, pos: nPos, sessions: new Set(samples.map((x) => x.group)).size, sha256: sha },
    q1_rules_only_A1: {
      candidate: "B (lex+cue+shape, no ngram)",
      protocol: "nested grouped CV (outer 8, inner 4), fold assignment salted 0.." + (splits - 1),
      splits, recallQuantiles: quant("recall"), fprQuantiles: quant("fpr"),
      resubstitutionRecall: r4(resub.recall ?? 0), resubstitutionFpr: r4(resub.fpr ?? 0),
      runs,
    },
    q2_explain: q2,
    q3_overfit: {
      features: posFeat, positives: nPos, epv: r4(nPos / posFeat),
      cvRecallMedian: quant("recall").p50, resubstitutionRecall: r4(resub.recall ?? 0),
      pooledAuc: r4(auc(pooled.map((p) => ({ score: p.margin, y: p.y }))) ?? 0),
      recallAtFpr: atFpr,
    },
  }, null, 2));
  return 0;
}

try { process.exitCode = main(); } catch (e) { console.error(e); process.exitCode = 3; }
