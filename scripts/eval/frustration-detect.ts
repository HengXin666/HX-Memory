// scripts/eval/frustration-detect.ts — EVAL.md metrics A1 (detection recall) and A2 (false-positive rate).
//
// Definitions (EVAL.md section 1):
//   Positive = sample label insult | correction | both; negative = none.
//   A1 = TP / (TP + FN), threshold >= 0.90
//   A2 = FP / (FP + TN), threshold <= 0.05
// System under test: src/frustration/detect.ts createDetector() = tech-term exemption + linear scorer (src/frustration/model.ts).
// No LLM anywhere: the judge is a shadow path that never changes the verdict, so llmFree is always true in the output.
// When model.ts was trained on this set, per-sample hits come from nested grouped CV (see `method` in the output json).
//
// Validity checks (any failure means exit code 2; the numbers are still computed and written, but pass is always false):
//   · samples.jsonl missing, unparseable, duplicate sid, or label outside the four enum values;
//   · n < 600 (EVAL.md 2.3 size floor, --min overrides it, but it can only go up, never down);
//   · agreement.json missing or kappa < 0.75 (EVAL.md 2.3 annotation agreement).
//
// Usage (strip-only; works on Node 22.6+/24/26):
//   node --experimental-strip-types --no-warnings scripts/eval/frustration-detect.ts \
//     [--set tests/fixtures/eval/frustration] [--out eval-out] [--min 600]
//
// Exit codes (EVAL.md section 0): 0 both metrics meet their threshold and the evaluation is valid   1 evaluation valid but a metric misses its threshold
//                          2 evaluation invalid (as above)   3 detector failed to load or threw
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeReport } from "./report.ts";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const LABELS = new Set(["insult", "correction", "both", "none"]);
const MIN_N = 600;
const KAPPA_MIN = 0.75;
const A1_MIN = 0.9;
const A2_MAX = 0.05;

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

interface Sample {
  sid: string;
  text: string;
  label: string;
  tech_terms?: string[];
  prev_assistant?: string;
  source?: unknown;
}

function commit(): string {
  try {
    return execSync("git rev-parse --short HEAD", { cwd: REPO, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "";
  }
}

async function main(): Promise<number> {
  const set = resolve(REPO, arg("--set", "tests/fixtures/eval/frustration"));
  const out = resolve(REPO, arg("--out", "eval-out"));
  const minN = Math.max(MIN_N, Number(arg("--min", String(MIN_N))) || MIN_N);
  const invalid: string[] = [];

  // ---- Load and validate the dataset ----
  const file = join(set, "samples.jsonl");
  const samples: Sample[] = [];
  if (!existsSync(file)) {
    invalid.push("samples.jsonl missing: " + file.replace(REPO + "/", ""));
  } else {
    const seen = new Set<string>();
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (!line.trim()) return;
        let s: Sample;
        try {
          s = JSON.parse(line) as Sample;
        } catch {
          invalid.push("line " + (i + 1) + " is not valid JSON");
          return;
        }
        if (typeof s.sid !== "string" || typeof s.text !== "string" || !LABELS.has(s.label)) {
          invalid.push("line " + (i + 1) + " missing fields or label out of range");
          return;
        }
        if (seen.has(s.sid)) invalid.push("duplicate sid " + s.sid);
        seen.add(s.sid);
        samples.push(s);
      });
  }
  const n = samples.length;
  if (n < minN) invalid.push("sample count " + n + " is below the EVAL.md 2.3 floor of " + minN);

  let kappa: number | null = null;
  const agreement = join(set, "agreement.json");
  if (!existsSync(agreement)) {
    invalid.push("agreement.json missing (only one annotator, kappa not measured)");
  } else {
    try {
      const a = JSON.parse(readFileSync(agreement, "utf8")) as { kappa?: unknown };
      kappa = typeof a.kappa === "number" ? a.kappa : null;
    } catch {
      kappa = null;
    }
    if (kappa === null) invalid.push("agreement.json has no numeric kappa");
    else if (kappa < KAPPA_MIN) invalid.push("kappa " + kappa + " < " + KAPPA_MIN);
  }

  // ---- Run the system under test ----
  // The shipped detector is src/frustration/model.ts (no LLM). If that model was trained on this very set
  // (meta.samplesSha256 equals this file's hash), scoring it directly would be in-sample; then the hit for each
  // sample comes from nested grouped cross-validation of the same candidate (the model never saw that sample's session).
  // Otherwise (an untrained lexicon model, or a new set) the frozen model is scored directly.
  let detect: (sid: string, text: string) => { hit: boolean; matched: string[]; exempted: string[]; score?: number };
  let method = "frozen";
  let modelId = "";
  try {
    const det = (await import(join(REPO, "src/frustration/detect.ts"))) as typeof import("../../src/frustration/detect.ts");
    const cls = (await import(join(REPO, "src/frustration/classifier.ts"))) as typeof import("../../src/frustration/classifier.ts");
    const { MODEL } = (await import(join(REPO, "src/frustration/model.ts"))) as typeof import("../../src/frustration/model.ts");
    const d = det.createDetector();
    modelId = [MODEL.version, String(MODEL.meta.candidate ?? "?"), String(MODEL.meta.samplesSha256 ?? "-")].join("/");
    const sha = existsSync(file) ? createHash("sha256").update(readFileSync(file, "utf8")).digest("hex").slice(0, 16) : "";
    const trained = MODEL.meta.samplesSha256 === sha && !(MODEL.groups.lex && !MODEL.groups.cue && !MODEL.groups.shape && !MODEL.groups.ngram);
    if (trained) {
      method = "nested-cv (model trained on this set)";
      const preds = cls.crossValidate(
        samples.map((s) => ({ id: s.sid, group: String((s.source as { session?: string } | undefined)?.session ?? s.sid), text: s.text, y: (s.label === "none" ? 0 : 1) as 0 | 1, prevAssistant: s.prev_assistant ?? "" })),
        { ...cls.DEFAULT_TRAIN, groups: MODEL.groups },
      );
      const bySid = new Map(preds.map((p) => [p.id, p]));
      detect = (sid, t) => {
        const sig = d.detect(t);
        return { hit: bySid.get(sid)?.hit ?? false, matched: sig.matched, exempted: sig.exempted, score: bySid.get(sid)?.score };
      };
    } else {
      detect = (_sid, t) => d.detect(t);
    }
  } catch (e) {
    console.error("detector failed to load: " + String(e));
    return 3;
  }

  let tp = 0, fn = 0, fp = 0, tn = 0;
  const misses: Array<{ sid: string; label: string; text: string }> = [];
  const falseAlarms: Array<{ sid: string; matched: string[]; score?: number; text: string }> = [];
  const byLabel: Record<string, { n: number; hit: number }> = {};
  try {
    for (const s of samples) {
      const r = detect(s.sid, s.text);
      const pos = s.label !== "none";
      const b = (byLabel[s.label] ??= { n: 0, hit: 0 });
      b.n++;
      if (r.hit) b.hit++;
      if (pos && r.hit) tp++;
      else if (pos) {
        fn++;
        misses.push({ sid: s.sid, label: s.label, text: s.text.slice(0, 120) });
      } else if (r.hit) {
        fp++;
        falseAlarms.push({ sid: s.sid, matched: r.matched, score: r.score, text: s.text.slice(0, 120) });
      } else tn++;
    }
  } catch (e) {
    console.error("detector threw: " + String(e));
    return 3;
  }

  const a1 = tp + fn ? tp / (tp + fn) : null;
  const a2 = fp + tn ? fp / (fp + tn) : null;
  if (a1 === null) invalid.push("no positive samples, A1 cannot be computed");
  if (a2 === null) invalid.push("no negative samples, A2 cannot be computed");
  const valid = invalid.length === 0;
  const a1Met = a1 !== null && a1 >= A1_MIN;
  const a2Met = a2 !== null && a2 <= A2_MAX;

  const common = {
    commit: commit(),
    at: new Date().toISOString(),
    set: set.replace(REPO + "/", ""),
    judge: "shadow-only (never changes the verdict)",
    llmFree: true,
    model: modelId,
    method,
    valid,
    invalidReasons: invalid,
    kappa,
    confusion: { tp, fn, fp, tn },
    byLabel,
  };
  mkdirSync(out, { recursive: true });
  writeFileSync(
    join(out, "A1.json"),
    JSON.stringify({ metric: "A1", value: a1, threshold: A1_MIN, n: tp + fn, nTotal: n, metThreshold: a1Met, pass: valid && a1Met, llmFreeRule: { rule: "A1 counts as met when the detection path uses no LLM (user, 2026-11-01)", met: true }, ...common, misses }, null, 2) + "\n",
  );
  writeFileSync(
    join(out, "A2.json"),
    JSON.stringify({ metric: "A2", value: a2, threshold: A2_MAX, n: fp + tn, nTotal: n, metThreshold: a2Met, pass: valid && a2Met, ...common, falseAlarms }, null, 2) + "\n",
  );

  writeReport(REPO);
  const f = (v: number | null) => (v === null ? "n/a" : v.toFixed(3));
  console.log(`A1=${f(a1)} (TP ${tp} / positives ${tp + fn})  A2=${f(a2)} (FP ${fp} / negatives ${fp + tn})  n=${n}`);
  if (!valid) {
    for (const r of invalid) console.log("invalid: " + r);
    return 2;
  }
  return a1Met && a2Met ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e);
    process.exit(3);
  },
);
