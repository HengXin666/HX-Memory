// scripts/eval/lesson-quality.ts — EVAL.md metric C1 (correction-lesson usefulness).
//
// Definition (EVAL.md section 1):
//   C1 = lessons that name a file/symbol and a concrete action / total lessons persisted, threshold >= 0.70.
//   EVAL.md scores this with a judge plus 20% human review. No model runs here, so this script uses the
//   repo's own gate as the scorer: a lesson counts as concrete when src/frustration/review.ts isConcrete(where)
//   holds and neither where nor wanted is a TEMPLATE_PHRASES stock phrase. The output marks judge:"off (isConcrete gate)",
//   so the number is "does the gate consider it concrete", a necessary condition, not the full judge score.
//
// Input: a lessons set, one JSON object per line, each {where, wanted, scope?}. Default --lessons
//   tests/fixtures/eval/frustration/lessons.jsonl. These are the lessons the same-turn review persisted;
//   generating them needs a live review model, which this environment does not have, so the file is normally
//   absent and C1 is reported as n=0 with exit code 2 (never 0), exactly like an empty eval set.
//
// Usage (strip-only works on Node 22.6+/24/26; dedupe.ts no longer uses constructor parameter properties):
//   node --experimental-strip-types --no-warnings scripts/eval/lesson-quality.ts \
//     [--lessons tests/fixtures/eval/frustration/lessons.jsonl] [--out eval-out]
//
// Exit codes (EVAL.md section 0): 0 C1 >= 0.70 and valid   1 valid but C1 < 0.70   2 invalid: lessons missing/empty/unparseable or below the 20-lesson floor   3 scorer failed to load or threw
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeReport } from "./report.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const C1_MIN = 0.7;
const LESSON_FLOOR = 20;

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

function commit(): string {
  try {
    return execSync("git rev-parse --short HEAD", { cwd: REPO, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "";
  }
}

interface LessonRow {
  where?: unknown;
  wanted?: unknown;
}

async function main(): Promise<number> {
  const lessonsPath = resolve(REPO, arg("--lessons", "tests/fixtures/eval/frustration/lessons.jsonl"));
  const out = resolve(REPO, arg("--out", "eval-out"));
  const invalid: string[] = [];

  let isConcrete: (where: string) => boolean;
  let TEMPLATE_PHRASES: readonly string[];
  try {
    const mod = (await import(join(REPO, "src/frustration/review.ts"))) as typeof import("../../src/frustration/review.ts");
    isConcrete = mod.isConcrete;
    TEMPLATE_PHRASES = mod.TEMPLATE_PHRASES;
  } catch (e) {
    console.error("scorer failed to load: " + String(e));
    return 3;
  }

  const rows: LessonRow[] = [];
  if (!existsSync(lessonsPath)) {
    invalid.push("lessons file missing: " + lessonsPath.replace(REPO + "/", "") + " (review model not run in this environment, no lessons persisted)");
  } else {
    readFileSync(lessonsPath, "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (!line.trim()) return;
        try {
          rows.push(JSON.parse(line) as LessonRow);
        } catch {
          invalid.push("line " + (i + 1) + " is not valid JSON");
        }
      });
  }
  if (rows.length < LESSON_FLOOR) invalid.push("lesson count " + rows.length + " is below the floor of " + LESSON_FLOOR);

  const isTemplate = (s: string) => TEMPLATE_PHRASES.some((p) => s.includes(p)) || s.trim().length < 6;
  let concrete = 0;
  const weak: Array<{ where: string; wanted: string; why: string }> = [];
  try {
    for (const r of rows) {
      const where = typeof r.where === "string" ? r.where : "";
      const wanted = typeof r.wanted === "string" ? r.wanted : "";
      const ok = isConcrete(where) && !isTemplate(where) && !isTemplate(wanted);
      if (ok) concrete++;
      else {
        const why = !isConcrete(where) ? "where names no file/symbol" : isTemplate(where) ? "where is a stock phrase" : "wanted is a stock phrase";
        weak.push({ where: where.slice(0, 80), wanted: wanted.slice(0, 80), why });
      }
    }
  } catch (e) {
    console.error("scorer threw: " + String(e));
    return 3;
  }

  const c1 = rows.length ? concrete / rows.length : null;
  if (c1 === null) invalid.push("no lessons, C1 cannot be computed");
  const valid = invalid.length === 0;
  const met = c1 !== null && c1 >= C1_MIN;

  mkdirSync(out, { recursive: true });
  writeFileSync(
    join(out, "C1.json"),
    JSON.stringify(
      {
        metric: "C1",
        value: c1,
        threshold: C1_MIN,
        n: rows.length,
        concrete,
        metThreshold: met,
        pass: valid && met,
        judge: "off (isConcrete gate)",
        valid,
        invalidReasons: invalid,
        commit: commit(),
        at: new Date().toISOString(),
        weak,
      },
      null,
      2,
    ) + "\n",
  );

  console.log(`C1=${c1 === null ? "n/a" : c1.toFixed(3)} (concrete ${concrete} / ${rows.length})`);
  if (!valid) {
    for (const r of invalid) console.log("invalid: " + r);
    return 2;
  }
  return met ? 0 : 1;
}

main().then(
  (code) => {
    writeReport(REPO);
    process.exit(code);
  },
  (e) => {
    console.error(e);
    process.exit(3);
  },
);
