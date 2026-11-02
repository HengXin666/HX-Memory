// tests/frustration/model-regression.test.ts — 模型换代的不回归门槛。这组不过 = 新模型比旧模型差, 不许上线。
//
// 来由 (2026-11-01): bootstrap 选型换上 B 后, 用户用真句子比 A/B (同一个 detect 只换 model): 7 条里 5 条从 HIT 掉成 MISS
// (「你他妈改错文件了」「不对, 我说的是A不是B」…), 原 22 条行为测试里 4 条失败。根因 shape:len<=12 = -0.88 压过脏话/纠正证据。
// 当时把失败当成「测试过期」是错的: 测试在盯行为, 失败说明模型退化。
//
// 句子集: tests/fixtures/eval/frustration/regression.jsonl (选型 train-frustration.ts 读同一份)。
//   expect=hit  必须判中;  expect=miss 必须不判中;  expect=open 只要求「A 判中则当前模型必判中」(A 与当前都漏的已知缺口)。
//   带 next_assistant_first 的行走后验路: 实时 detect() 之后 compensateAtTurnEnd()。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compensateAtTurnEnd, createDetector, LEXICON_MODEL } from "../../src/frustration/detect.ts";
import { extractFeatures } from "../../src/frustration/features.ts";
import { MODEL } from "../../src/frustration/model.ts";

interface Row { id: string; text: string; expect: "hit" | "miss" | "open"; next_assistant_first?: string }
const rows: Row[] = readFileSync("tests/fixtures/eval/frustration/regression.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l));
const lexicon = createDetector({ model: LEXICON_MODEL });
const current = createDetector({ model: MODEL });
const judge = (det: typeof current, r: Row) => {
  const rt = det.detect(r.text);
  return r.next_assistant_first === undefined ? rt.hit : compensateAtTurnEnd(rt, r.next_assistant_first, MODEL).hit;
};

describe("frustration model regression (换代门槛)", () => {
  it.each(rows.filter((r) => r.next_assistant_first === undefined))("实时 $id「$text」 expect=$expect", (r) => {
    const a = lexicon.detect(r.text).hit;
    const got = current.detect(r.text);
    if (r.expect === "hit") expect({ hit: got.hit, score: got.score }).toMatchObject({ hit: true });
    if (r.expect === "miss") expect(got.hit).toBe(false);
    if (a) expect(got.hit).toBe(true); // 任何一行: A 判中的, 当前模型不许丢
  });

  it.each(rows.filter((r) => r.next_assistant_first !== undefined))("后验 $id「$text」→「$next_assistant_first」 expect=$expect", (r) => {
    const rt = current.detect(r.text);
    const post = compensateAtTurnEnd(rt, r.next_assistant_first!, MODEL);
    expect(post.hit).toBe(r.expect === "hit");
    if (r.expect === "hit" && !rt.hit) expect(post.via).toBe("posterior");
    // 实时路不得读未来: 同一句的 detect() 结果与有没有助手回复无关
    expect(current.detect(r.text).hit).toBe(rt.hit);
  });

  it("标注集 196 条: A 判中的每一条, 当前模型都判中", () => {
    const s = readFileSync("tests/fixtures/eval/frustration/samples.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const lost = s.filter((r) => lexicon.detect(r.text, r.prev_assistant).hit && !current.detect(r.text, r.prev_assistant).hit).map((r) => r.sid);
    expect(lost).toEqual([]);
  });

  it("通过数: 当前模型不少于 A", () => {
    const pass = (det: typeof current) => rows.filter((r) => r.expect !== "open" && judge(det, r) === (r.expect === "hit")).length;
    expect(pass(current)).toBeGreaterThanOrEqual(pass(lexicon));
  });

  it("短句特征不抵消词表证据: 命中词表时不记 shape:short-nolex", () => {
    const G = { lex: true, cue: true, shape: true, ngram: false };
    expect(extractFeatures("错了", G).has("shape:short-nolex")).toBe(false);
    expect(extractFeatures("say OK", G).has("shape:short-nolex")).toBe(true);
  });
});
