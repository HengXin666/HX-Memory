# ASSISTANT-CUES — 用户不满之后, 助手下一条消息的首句

生成: 2026-11-01 19:52 CST。覆盖上一版 (上一版按目录名取前 20 个会话, 抽到的全是子代理会话, 作废)。

## 复现

```bash
TK=<token>
# 抽样 A: HX-Memory 桶, 排除子代理会话, 按用户原话条数取前 20
python3 scripts/eval/assistant-cues-extract.py --top 20 --out .tmp/ac2/pairs.jsonl \
  --bucket "https://fs.lolioa.com/fs/home/hx/.dsh/sessions/--home-hx-Loli-code-HXLoLis-components-HX-Memory--?token=$TK"
# 抽样 B: 人工标注样本所在的会话 (真值只在这里有)
python3 scripts/eval/assistant-cues-extract.py --out .tmp/ac3/pairs.jsonl \
  --samples tests/fixtures/eval/frustration/samples.jsonl --sessions "https://fs.lolioa.com/fs/home/hx/.dsh/sessions?token=$TK"
for d in ac2 ac3; do node --experimental-strip-types --no-warnings scripts/eval/assistant-cues-detect.ts .tmp/$d/pairs.jsonl .tmp/$d/detected.jsonl; done
python3 scripts/eval/assistant-cues-stats.py .tmp/ac2/detected.jsonl --truth human  > .tmp/ac2/stats-human.json   # [A-h]
python3 scripts/eval/assistant-cues-stats.py .tmp/ac2/detected.jsonl --truth detect > .tmp/ac2/stats-detect.json  # [A-d]
python3 scripts/eval/assistant-cues-stats.py .tmp/ac3/detected.jsonl --truth human  > .tmp/ac3/stats-human.json   # [B-h]
```

`[A-h].键` / `[A-d].键` / `[B-h].键` 指对应 JSON 的键。口径: 用户原话 = `type=user/message` 且 `data.source.kind=="user"`; 下一条 assistant 消息 = 其后第一条 `type=assistant/message` (在下一条用户原话之前); 首句 = 它 `data.message.content` 里第一个 `type=text` 且非空的块; 前缀 = 首句 strip 后前 12 个字符。会话整份读, 这一版不设每会话消息条数上限。真值: `samples.jsonl` 中 label ∈ {insult, correction, both} 为阳性, `none` 为阴性, 按 `source.msg_id` 对齐。

## 1. 数据规模

### 抽样 A: HX-Memory 桶 (按要求的抽样)

| 项 | 数 | 来源 |
|---|---|---|
| 桶里会话 | 59 | `[A-h].sessions_read` |
| 排除的子代理会话 | 49 (有 subagent/descriptor 31 个; 没有 descriptor 但首条 user/message 的 source.kind 不是 user 18 个) | `sessions_excluded_subagent` / `_by_descriptor` / `_by_first_source_kind` |
| 剩下可选的会话 | 10 (不足 20, 全部入选) | `[A-h].sessions_selected` |
| 入选会话的用户原话 | 49 (各会话 12, 8, 6, 6, 5, 4, 3, 2, 2, 1) | `user_msgs`, `selected_user_msgs_per_session` |
| 与人工标注对上的 | **0** (196 条标注样本没有一条来自这个桶) | `[A-h].labeled_matched`, `labeled_samples_not_found = 196` |

抽样 A 上没有人工真值, 所以按要求的口径在 A 上算不出任何精确率 / 召回率。A 上用 detect 当真值的数字只作参考 (第 2 节末)。

### 抽样 B: 标注样本所在的会话 (真值来源)

| 项 | 数 | 来源 |
|---|---|---|
| 会话 | 40 (其中首条 source.kind 不是 user 的 10 个; 没有排除, 因为标注就打在这些消息上) | `[B-h].sessions_read`, `sessions_excluded_subagent` |
| 用户原话 | 485 | `[B-h].user_msgs` |
| 对上标注的 | 196 / 196 (其余 289 条用户原话没有标注, 不参与) | `labeled_matched`, `labeled_unmatched_in_these_sessions` |
| 阳性 (insult / correction / both) | 52; 有下一条 assistant 消息 51; **配到首句 37** | `positive_turns`, `positive_with_next_asst_msg`, `positive_with_first_text` |
| 阴性 (none) | 144; 有下一条 assistant 消息 125; 配到首句 91 | `negative_turns`, `negative_with_next_asst_msg`, `negative_with_first_text` |
| 基线 (配到首句里阳性占比) | 37 / 128 = 0.289 | `[B-h].base_rate` |

## 2. 首句前缀频次表 (前 12 字, 抽样 B, 人工真值)

在阳性的 37 条首句里, **没有任何 12 字前缀出现 2 次以上** (`[B-h].prefixes_ge2_in_positive = []`): 37 条全部互不相同 (`[B-h].all_positive_prefixes`)。原因是 12 字已经越过模板部分, 例如 `你说得对，养号对**新账` / `你说得对，我的对照实验有` / `你说得对，我在手搓对照实` 是三个不同前缀。

所以模板只能在更短的开头上看。按指定的四个道歉开头单列 (首句以该词开头即算, `[B-h].apology_openers`):

| 开头 | 阳性首句中 | 阴性首句中 | 精确率 (Wilson 95%) | 召回率 (Wilson 95%) | 其中 detect 漏判的阳性 |
|---|---|---|---|---|---|
| 你说得对 | 9 | 1 | 9/10 = 0.90 [0.60, 0.98] | 9/37 = 0.24 [0.13, 0.40] | 6 |
| 抱歉 | 0 | 0 | — | 0/37 | 0 |
| 我的错 | 0 | 0 | — | 0/37 | 0 |
| 你说错了 | 0 | 0 | — | 0/37 | 0 |
| 四者任一 | 9 | 1 | 0.90 [0.60, 0.98] | 0.24 [0.13, 0.40] | 6 |

「我的错」在阳性首句里出现过, 但不在开头 (`立刻处理——`Xephyr :98` 会在你的桌面上开窗口，那是我的错。`, 见 `[B-h].positive_first_texts`), 按开头口径不计。唯一的阴性命中是用户说「同一个网络环境」、助手回「你说得对，我的对照实验有硬伤…」, 标注为 none。

参考 (抽样 A, detect 当真值, `[A-d]`): 49 条用户原话里 detect 阳性 13 条, 配到首句 6 条, 阴性配到首句 14 条; 阳性里没有出现 2 次以上的前缀, 四个道歉开头在阳性和阴性里都是 0 次。

## 3. 哪些首句模式可以当辅助特征

- 只有「你说得对」开头有信号: 在本样本上精确率 0.90 [0.60, 0.98], 高于基线 0.289; 召回率 0.24 [0.13, 0.40]。它命中的 9 条阳性里有 6 条是现有 detect 漏判的 (`in_positive_missed_by_detect`), 即作为辅助特征它补的主要是 detect 的漏报。
- 「抱歉」「我的错」「你说错了」作开头在本样本里 0 次, 无法评估, 不能加。
- 12 字前缀这个粒度不能用 (阳性里没有重复的前缀)。
- 精确率的分母只有 10 次命中, 95% 区间下限 0.60; 现在只能说「你说得对」开头值得进下一轮评估, 不能说它已经可用。是否加入特征集要等第 4 节的样本量。

另外, 这个特征依赖助手已经回了第一条带文字的消息: 在 52 条阳性里, 下一条 assistant 消息没有 text 块的有 51 − 37 = 14 条 (只有 reasoning / tool-call), 这些轮次它天然测不到。

## 4. 样本量不足

这个特征需要人工标注扩到 **686 条** 才能评估 (现在 196 条)。

算法 (`[B-h].labels_needed`): 要求「道歉开头」的精确率和召回率的 95% 区间半宽都不超过 0.10。按本样本的点估计, 精确率需要 35 次命中 (1.96² × 0.9 × 0.1 / 0.1²), 召回率需要 71 条配到首句的阳性 (1.96² × 0.24 × 0.76 / 0.1²)。本样本每条标注平均带来 0.051 次命中、0.189 条配到首句的阳性, 折算: 精确率要 35 / 0.051 = 686 条标注, 召回率要 71 / 0.189 = 377 条。取大者 686。这是按当前标注的分布估算的; 标注集现在 136 / 196 条来自 HX-Jungle 一个桶 (samples.jsonl 的 source.bucket), 换桶后命中率可能变化, 届时要重算。

HX-Memory 桶本身: 排除子代理后只剩 10 个会话、49 条用户原话, 而且一条标注都没有, 在这个桶上评估需要先给这 49 条打标。
