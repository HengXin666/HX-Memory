// scripts/eval/len-feature-dist.ts — 短句特征在标注集上的正负分布 (DETECT-REPORT.md「shape:len<=12 分布」一节的数据来源)。
// 用法: node --experimental-strip-types --no-warnings scripts/eval/len-feature-dist.ts [--set tests/fixtures/eval/frustration]
// 长度口径与 features.ts 相同: 技术词遮罩后 trim, 按 Unicode 码点计数。
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { maskTechTerms } from "../../src/frustration/detect.ts";
import { detectNegative, compileNegativity } from "../../src/kernel/negativity.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const i = process.argv.indexOf("--set");
const setDir = resolve(REPO, i >= 0 ? process.argv[i + 1]! : "tests/fixtures/eval/frustration");
const c = compileNegativity();
const rows = readFileSync(join(setDir, "samples.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const BUCKETS: Array<[string, number, number]> = [["1-6", 1, 6], ["7-12", 7, 12], ["13-30", 13, 30], ["31-119", 31, 119], [">=120", 120, 1e9]];
const tab = BUCKETS.map(([name]) => ({ bucket: name, pos: 0, neg: 0, lexPos: 0, lexNeg: 0, noLexPos: 0, noLexNeg: 0 }));
const short: Array<{ sid: string; y: number; lex: boolean; text: string }> = [];
for (const r of rows) {
  const t = maskTechTerms(r.text).masked.trim();
  const len = [...t].length;
  const y = r.label === "none" ? 0 : 1;
  const lex = detectNegative(maskTechTerms(r.text).masked, c).hits.length > 0;
  const b = tab[BUCKETS.findIndex(([, lo, hi]) => len >= lo && len <= hi)] ?? tab[0]!;
  if (y) { b.pos++; lex ? b.lexPos++ : b.noLexPos++; } else { b.neg++; lex ? b.lexNeg++ : b.noLexNeg++; }
  if (len <= 12) short.push({ sid: r.sid, y, lex, text: r.text.slice(0, 40) });
}
const P = rows.filter((r) => r.label !== "none").length;
const sp = short.filter((s) => s.y).length, sn = short.length - sp;
const out = {
  n: rows.length, pos: P, baseRate: +(P / rows.length).toFixed(3),
  short: { n: short.length, pos: sp, neg: sn, posRate: +(sp / short.length).toFixed(3), lexPos: short.filter((s) => s.y && s.lex).length, lexNeg: short.filter((s) => !s.y && s.lex).length },
  long: { n: rows.length - short.length, pos: P - sp, neg: rows.length - P - sn, posRate: +((P - sp) / (rows.length - short.length)).toFixed(3) },
  buckets: tab.map((b) => ({ ...b, posRate: b.pos + b.neg ? +(b.pos / (b.pos + b.neg)).toFixed(3) : null })),
  shortPositives: short.filter((s) => s.y),
  shortNegativesFirst15: short.filter((s) => !s.y).slice(0, 15),
};
mkdirSync(join(REPO, "eval-out"), { recursive: true });
writeFileSync(join(REPO, "eval-out/len-feature-dist.json"), JSON.stringify(out, null, 2) + "\n");
console.log(`n=${out.n} pos=${out.pos} base=${out.baseRate}  len<=12: ${sp}+/${sn}- (阳性率 ${out.short.posRate})  len>12: ${out.long.pos}+/${out.long.neg}- (阳性率 ${out.long.posRate})`);
for (const b of out.buckets) console.log(`  ${b.bucket.padEnd(7)} ${b.pos}+/${b.neg}-  阳性率 ${b.posRate}  命中词表 ${b.lexPos}+/${b.lexNeg}-  未命中 ${b.noLexPos}+/${b.noLexNeg}-`);
console.log("短句阳性: " + out.shortPositives.map((s) => `${s.sid}「${s.text}」`).join(" "));
console.log("短句阴性 (前15): " + out.shortNegativesFirst15.map((s) => `${s.sid}「${s.text.replace(/\n/g, " ")}」`).join(" "));
