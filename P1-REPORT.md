# P1 报告: 挫折链路合并 + 同轮评审

**结论: P1 判据不能判通过。** 代码在真仓库上通过 (vitest 全量只剩 docs-gate 那条既有失败, tsc 退出码 0)。但种子集只有 196 条, 低于 EVAL 2.3 要求的 600 条, 而且只有 1 名标注人; 在这个集上实测 A1 = 0.269 (未达标), A2 = 0.042, 两个脚本的退出码都是 2 (评测无效)。C1 没有教训可评 (n = 0), 退出码 2。C3 未测。

## 1. 本轮执行的动作

代码在本地写完、测试通过后, 已逐个 PUT 到映射目录, 回读与本地逐字节一致 (新建 HTTP 201, 覆盖 HTTP 200):

| 文件 | 行数 | 说明 |
|---|---|---|
| src/frustration/detect.ts | 122 | 词表 + 技术词豁免 (TECH_TERMS, 先遮掉技术词再跑词表) + 判官兜底 (只在词表没命中时调用, 只能补判「是」) |
| src/frustration/dedupe.ts | 75 | 按「会话 + 消息 id」去重; 没有 id 时用「第几条用户消息 + 正文哈希」 |
| src/frustration/review.ts | 218 | 评审材料 (触发前 N 轮, 带轮号, 含助手和工具消息, 加最近 diff); 固定结构 where / wanted / scope / evidence; 入库闸门: 证据原话必须逐字出现在材料里、轮号不越界、拒收模板句 |
| src/frustration/rules.ts | 75 | 规则一条一个文件, 存在 `<记忆根>/rules/lessons/<id>.json` (临时文件 + fsync + rename); 按仓库与目录前缀匹配 |
| src/frustration/pipeline.ts | 219 | 每个 pre-step 调一次: 第一次见到这条消息时检测, 命中就在后台起评审; 同一轮的下一个 step 等结论 (最多 45 s), 结论只注入一次; 新会话的第一个 step 注入同范围规则 |
| src/frustration/workspace.ts | 28 | 定位仓库根 (git rev-parse) 和最近 diff (git diff HEAD, 为空时取 git show HEAD), 最多 8000 字 |
| src/frustration/index.ts | 7 | 对外出口 |
| src/adapters/dsh/frustration-wiring.ts (新建) | 52 | 装配: 词表和判官复用 negativity-wiring; 评审走 agentSummarize, 超时 60 s; `HX_FRUSTRATION_PIPELINE=0` 时关闭 |
| src/adapters/dsh/prestep.ts | 355 | 新增 `frustration` 选项, 输出并入同一个注入块, 不受 first 模式限制 |
| src/adapters/dsh/prestep-wiring.ts | 138 | 本链路启用时不再传旧的 negativeHint / onNegative / detectNegative |
| src/adapters/dsh/negativity-wiring.ts | 240 | 暴露 `compiled()`, 让本链路和设置面板用同一份词表 |
| src/adapters/dsh/index.ts | 440 | 本链路启用时, capture 拿不到 negativity, 轮末不再产出模板教训 |
| tests/frustration/pipeline.test.ts | 225 | 22 条用例, 多 step 回放都经过 makePreStepHandler (EVAL F7) |

## 2. 验证

**以下 3 行结果来自你在真仓库上的运行, 以真仓库为准。** 我这边副本的报错不作为结论。

| 命令 (真仓库) | 结果 | 退出码 |
|---|---|---|
| `npx vitest run tests/frustration` | 22/22 通过 | 0 |
| `npx vitest run` (全量) | 191 个文件、1415 条用例通过; 唯一失败是 docs-gate 那条既有问题, 与本次改动无关 | 非 0 (只因 docs-gate) |
| `./node_modules/.bin/tsc --noEmit -p .` | 无报错 | **0** |

上一版这里写的是「非 0 (副本问题)」, 那是用副本的结果下了结论, 是错的, 现已改正。

22 条用例覆盖: 命中 4 条; 技术词不误报 7 条; 判官调用时机; 一轮 10 个 step 时检测 1 次、评审 1 次、结论在第 2 个 step 注入 1 次; 评审慢时下一个 step 会等结论; 同一句话在后面的轮次再说算新的一次; 没证据不入库; 评审报错不入库; 新会话按仓库和目录注入规则, 其它仓库和兄弟目录不注入; 闸门拒收编造的原话、越界轮号、模板句、非 JSON; 模型编造的仓库路径改回材料里的仓库根。

## 3. 测试集 (第 1 步)

新增文件:

| 文件 | 行数 | 内容 |
|---|---|---|
| tests/fixtures/eval/frustration/samples.jsonl | 196 | 种子集, 字段按 EVAL 2.3, 另加 `prev_assistant` 和 `source` |
| tests/fixtures/eval/README.md | 见文件 | 写明「种子集 196 条, 低于 EVAL 2.3 下限 600」, 并记录抽样过程、标注规则和脱敏方法 |

- 会话: 取了 40 个, 覆盖 6 个桶 (HX-Jungle 136 条, HX-BCP 27, HX-CF-Tunnel 16, home 12, HX-Email 4, .sec-test 1)。没有新下载会话, 全部来自本地已缓存的 108 个 (其中 1 个文件截断读不了)。
- 「优先最近的」没有严格照做, 原因是: 按创建时间排, 最近的 40 个会话几乎都是自动探针 (「回一个字 ok」「Reply with exactly: PONG」), 加起来只有约 40 条消息。所以改成按用户消息条数排序, 条数相同时取较新的。这一偏差已写进 README。
- 标签分布: none 144 / correction 43 / both 7 / insult 2。正例 52 条, 正负比约 1 : 2.8。宽松词表命中 94 条, 其中 42 条是正例; 另有 10 个正例宽松词表也没抓到, 它们照样在集合里, 因为这 40 个会话总共只有 196 条消息, 已经全部收入。
- 不达 EVAL 2.3 的地方: 规模 196 < 600; 含技术词的 none 只有 5 条 (要求 ≥ 100); 只有 1 名标注人, 没有 `agreement.json` (kappa 未测); 29 个桶只覆盖了 6 个。

## 4. 评测脚本与实测 (第 2 步)

| 文件 | 行数 | 口径 |
|---|---|---|
| scripts/eval/frustration-detect.ts | 187 | A1 = TP/(TP+FN), 阈值 ≥ 0.90; A2 = FP/(FP+TN), 阈值 ≤ 0.05。被测对象是 `createDetector().detect` (词表 + 技术词豁免), 不调用判官 (`judge: "off"`)。以下任一情况退出码为 2, 且 `pass` 恒为 false: 样本数 < 600, 缺少 agreement.json 或 kappa < 0.75, 数据格式错误 |
| scripts/eval/lesson-quality.ts | 142 | C1 = 具体教训数 / 教训总数, 阈值 ≥ 0.70。由于没有判官, 用仓库自带的闸门打分: `isConcrete(where)` 为真且 where 和 wanted 都不是模板句才算具体 (`judge: "off (isConcrete gate)"`)。教训文件缺失或少于 20 条时退出码为 2 |

运行方式: `node --experimental-strip-types --no-warnings scripts/eval/<名>.ts`。(2026-11-02 更正: 原文写的是 `--experimental-transform-types`, 理由是 dedupe.ts 用了构造参数属性; 该参数属性已改成显式字段, transform-types 在 Node 26 上是 bad option, 现统一用 strip-types。见 FIX-ROUND-1.md 第 4 节。)

实测结果 (种子集, 本地副本; 两个脚本只读 src/frustration 和 samples.jsonl):

| 指标 | 值 | n | 混淆矩阵 | 阈值 | 退出码 | 输出 |
|---|---|---|---|---|---|---|
| A1 | **0.269** | 52 个正例 (共 196) | TP 14, FN 38 | ≥ 0.90, 未达 | **2** (样本不足 + 无 kappa) | eval-out/A1.json |
| A2 | **0.042** | 144 个负例 | FP 6, TN 138 | ≤ 0.05, 达到 | **2** (同上) | eval-out/A2.json |
| C1 | **无值** | 0 | — | ≥ 0.70 | **2** (缺少 lessons.jsonl) | eval-out/C1.json |

结果解读 (依据 eval-out/A1.json 中的 `misses` 和 A2.json 中的 `falseAlarms`):
- A1 偏低, 主因是纠正型消息大多不含词表字面。按标签看命中率: correction 8/43, both 5/7, insult 1/2。典型漏判: f162「协议化了吗？我不要浏览器的」, f123「整理清楚再动手。」, f135「太慢了」, f064「我不是让你说中文吗？…你听不懂吗？」(「我不是」不在词表里)。这类消息要靠判官兜底, 而本脚本没有调用判官, 所以 0.269 只是「只用词表」时的数, 不是整条链路的召回。
- A2 的 6 条误报: 3 条来自祈使禁令正则 (f005「不要解释」, f008「不要问甲方」, f095「不要猜端点…」), 是用户写需求时的「不要…」被当成了纠正; 另外 3 条是纠正词出现在普通提问里 (f051「我是说」, f111「应该是」, f142「我的意思」)。6 条里没有一条是技术词误报。
- C1 没有值: 计算它需要同轮评审实际沉淀出来的教训, 而生成教训要调用评审模型 (`agentSummarize`), 我这边的环境没有。在你的机器上用真会话把正例跑一遍评审, 把结果写成 `tests/fixtures/eval/frustration/lessons.jsonl` (每行 `{where, wanted, scope}`), 然后 `lesson-quality.ts` 就能出数。

## 5. 会话格式 (供 P3 使用)

两种格式都见过: 196 条样本里来自 v3 会话的 146 条, 来自 v4 会话的 50 条。下面的结构在两种格式里一致 (本地解压实测)。

- 文件: `~/.dsh/sessions/<桶>/session-<uuid>/session.v4.jsonl.zstd`, 老会话是 `session.v3.jsonl.zstd`, 两个都要找, 先找 v4。用 `zstd -dc` 解压后是 JSONL, 每行一个事件。第 1 行是 `{"type":"session","version":3|4,"createdAt":<毫秒>,"cwd":...}`。
- **用户消息与助手消息存放的位置不一样**, v3 和 v4 一样:
  - `type = "assistant/message"`: 消息在 `data.message`, 即 `{role:"assistant", content:[{type:"reasoning"|"text"|"tool-call",...}]}`, 另外 `data.turn` 和 `data.step` 给出轮号和 step 号。
  - `type = "user/message"`: **消息直接就是 `data` 本身**, 即 `{content, source, role:"user", id}`, 没有 `data.message` 这一层。你给的「消息在 data.message」只对 assistant 成立, 在 user 上不成立。之前的抽取脚本就是因为照 data.message 去读 user 消息, 一条都没抽到, 后来按上面的结构改过。
  - 区分用户原话和插件注入: 用户原话的 `data.source.kind = "user"`; 插件注入 (如【相关记忆】、HX-Memory 使用说明) 的 `source.kind = "plugin"`, 而且同样以 `user/message` 的形式出现。在本地 107 个可读会话里, 插件注入共 575 条, 用户原话 303 条。
  - 同一条插件注入还会以 `agent/inbox/spliced` 的形式再出现一次 (在 `data.inserted[]` 里)。去重按 `id` 做。
- 从远端拉取时, 大会话可能截断 (`zstd: premature end`)。前面已经解出来的行可以照常用, 但不要假设读到的是完整会话。

## 6. 未做 / 未测

- **C3: 未测** (需要 correction-effect.ts --same-turn, 属于 P2/P3)。
- **A3 的 `--replay` 真会话回放: 未测**, frustration-detect.ts 没有实现 `--replay`; 目前只有单元测试层面的结果 (maxReviewPerMessage = 1)。
- **A1 / A2 的判官兜底那一路: 未测** (需要模型)。
- **C1: 无值** (见第 4 节)。
- 测试集离 EVAL 2.3 的要求还差: 样本扩到 600 条以上, 含技术词的负例补到 100 条, 加第二名标注人和 agreement.json, 覆盖更多桶。
- **既有问题, 本次没动**: AGENTS.md 和 docs-gate 两处既有的文档引用问题 (全量 vitest 唯一的失败就是 docs-gate 这条)。按你的要求只在这里记录, 没有改。
