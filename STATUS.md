# STATUS (2026-11-02 22:40 CST, FIX-ROUND-1)

- 挫折检测线上候选: **A (现有词表)**, 由 `scripts/eval/train-frustration.ts` 按严格门限选出 (FPR 点估计 <= 0.05, 区间不作豁免)。A1 = 0.269, A2 = 0.042 (196 条留出)。A1 远低于 0.90, **无候选达到 A1**。
- 之前的 E (召回 0.442, FPR 0.083) 已因 FPR 点估计 > 0.05 被淘汰, 不再上线。复核: `curl` 不可用时用面板 `POST /api/detect`, 返回 `"candidate":"A"`。
- 判官 (同轮评审) 未配置: 面板 `/api/model` 的 `judgeConfigured=false`。
- 详情与复现命令: FIX-ROUND-1.md。

---
以下为历史状态 (2026-11-01, 已过期):

1 Actions this round (in progress, 17:42): detection is now a non-LLM linear scorer (src/frustration/features.ts, classifier.ts); the judge is demoted to a shadow path; 4 candidates compared with nested grouped CV: A lexicon 0.269/0.042, B rules 0.365/0.063, C ngram 0.154/0.063, D both 0.231/0.049 (recall/false-positive rate).
2 Blockers: none; P2 sync and the auto-regenerated eval page are being written.
3 Next step: PUT all files and the report when done; STATUS.md will be overwritten again.
