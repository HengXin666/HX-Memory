// scripts/eval/assistant-cues-detect.ts — 对 extract.py 抽出的每条用户原话跑现有 detect (src/frustration/detect.ts, 当前 model.ts)。
// 用法: node --experimental-strip-types --no-warnings scripts/eval/assistant-cues-detect.ts <pairs.jsonl> <out.jsonl>
// 输出: 每行 = 输入行 + { neg: boolean, kinds: string[], score, threshold, model }。不调用任何模型, 同一输入 ⇒ 同一输出。
import { readFileSync, writeFileSync } from "node:fs";
import { createDetector } from "../../src/frustration/detect.ts";

const [inp, out] = process.argv.slice(2);
if (!inp || !out) {
  console.error("usage: detect.ts <pairs.jsonl> <out.jsonl>");
  process.exit(2);
}
const det = createDetector();
const lines = readFileSync(inp, "utf8").split("\n").filter((l) => l.trim());
const res: string[] = [];
let neg = 0;
for (const l of lines) {
  const r = JSON.parse(l);
  const s = det.detect(String(r.user ?? ""));
  if (s.hit) neg++;
  res.push(JSON.stringify({ ...r, neg: s.hit, kinds: s.kinds, score: s.score, threshold: s.threshold, model: s.model }));
}
writeFileSync(out, res.join("\n") + "\n");
console.log(`rows ${lines.length} neg ${neg}`);
