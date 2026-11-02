// src/frustration/model.ts — 由 scripts/eval/train-frustration.ts 生成, 不要手改 (改了下次训练会被覆盖)。
// 重新生成: node --experimental-strip-types --no-warnings scripts/eval/train-frustration.ts
// 选型: FPR 点估计 <= 0.05 且过回归门槛的候选按留出召回排序, A 最高 (召回 0.269, FPR 0.042 [0.015, 0.076]); 淘汰: B (回归句 6/15 < A 15/15, 丢了 A 判中的 r06/r07/s01/s02/s03/s04/s05/s06/s07), C (回归句 2/15 < A 15/15, 丢了 A 判中的 r01/r02/r03/r04/r06/r07/s01/s02/s03/s04/s05/s06/s07), D (回归句 2/15 < A 15/15, 丢了 A 判中的 r01/r02/r03/r04/r06/r07/s01/s02/s03/s04/s05/s06/s07), E (FPR 点估计 0.083 > 0.05, 区间 [0.046, 0.133] 不作豁免)
import type { LinearModel } from "./classifier.ts";

export const MODEL: LinearModel = {
  "version": "linear-1",
  "groups": {
    "lex": true,
    "cue": false,
    "shape": false,
    "ngram": false
  },
  "bias": 0,
  "threshold": 1,
  "weights": {
    "lex:blame-method": 1,
    "lex:blame-execution": 1,
    "lex:correction": 1
  },
  "meta": {
    "candidate": "A",
    "note": "lexicon equivalent",
    "samplesSha256": "7085d7bb58440619",
    "trainedBy": "scripts/eval/train-frustration.ts"
  }
};
