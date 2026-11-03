# EVAL-VERDICT（2026-11-03）

本轮只做证据和判断，不给方案。

## 0 复现
```
HX_MEMORY_EMBEDDING_BASE_URL=http://127.0.0.1:4399/v1 HX_MEMORY_EMBEDDING_MODEL=Qwen3-Embedding-0.6B \
  taskset -c 0-3 nice -n 19 node --experimental-strip-types --no-warnings bench/qualitative.ts
```
- 结果：code 0，用时 2.0s。缓存原有 2536 条，本次新嵌入 3 段（3 条 query 和 1 段语料），之后缓存 2539 条。产物 `eval-out/qualitative.json`。
- 语料：`.tmp/bench/corpus-r2.json`，共 1287 条，即线上 active 记忆的导出。
- A 和 B 检索的是**同一批已抽取的条目**：
  - A 朴素：Qwen3-0.6B 向量，按 512 字切块，每个条目取块的最大余弦。
  - B 现有混合：用 bench 的 H0 配置（BM25 + 词法向量 + 规则），调用 `retrieveSync({text, limit:3, purpose:"recall"})`。线上没有配语义嵌入，H0 最接近线上的实际状态。
- 第 1 次运行 exit 1：corpus 里有 `kind=rule` 的条目，导出时没带 confirmedBy，被 file-store 拒绝。修正方法是给 rule 条目补上 `confirmedBy:"export"`，只用于这个临时库。

## 1 定性对比（原文前 100 字，不改写）

### q1 跨项目问规则：「之前定过的规则里, 关于提交前要不要跑测试是怎么说的」
| # | 分数 | kind | project | 内容 |
|---|---|---|---|---|
| A1 | 0.7175 cos | preference | - | 【最高优先级·强制】测试纪律: 禁止编一个文件就跑一次测试、编一堆文件就跑一次测试。测试只在【所有任务全部完成之后、提交之前】做一次最终测试。中途反复跑测试属于禁止行为(开发效率杀手)。例外: 只有用 |
| A2 | 0.6828 cos | preference | - | 【强制】禁止反复跑测试. 测试只在 GitHub 上跑, 且只有用户明确要求时才允许本地跑测试. 改一个字符就跑测试属于禁止行为. |
| A3 | 0.6412 cos | lesson | freebuff-proxy | 禁止一直测试。 (起因: next 快点！别一直测试。测试只能测试diff相关的) |
| B1 | 0.2446 | preference | - | （与 A1 是同一条） |
| B2 | 0.2337 | pattern | HXLoLis | 算了，你去看一下b站，去沉淀一下你的语境 我刚刚直接告诉你答案，你还是写出这么垃圾的东西 自己去浏览，自己去学习，不要一直问我自己去领会这种东西，你没有见过一定量的东西。之前你是绝对不可能知道这些东西 |
| B3 | 0.2075 | lesson | HX-Memory | HX-Memory 用户视角验收: 首轮注入的完整内容 (~692 token, 每会话一次) (2026-09-18)。**做法**: 用**新写的 withClonedMemoryRoot 工具* |

判断：两边 top1 是同一条，都用得上。A 的 3 条都和测试规则有关，A2 还与 A1 有冲突（「提交前跑一次」对「只在 GitHub 跑」），人能看到冲突。B2、B3 和测试无关。**这句 A 更好。**

### q2 召回 lesson：「又忘了之前的教训, 同一个错误犯了第二次」
| # | 分数 | kind | project | 内容 |
|---|---|---|---|---|
| A1 | 0.5896 cos | lesson | HX-Memory | HX-Memory 补齐 §466 的证据链: 因果**一一对应**, 根因得到必然性证明 (2026-09-18)。**为什么补这一轮**: §466我把根因判为'同毫秒碰撞导致 best 选错' |
| A2 | 0.5810 cos | context | HXLoLis | 我已经重启，你可以继续 |
| A3 | 0.5803 cos | context | freebuff-proxy | 你不要帮你自己重新实现 |
| B1 | 0.2274 | lesson | HX-Memory | HX-Memory 追'那6个孤儿能否清掉': 而我在同一件事上**第三次犯了同一个判据错误** (2026-09-18)。**起点**: §544的分层读数说'真孤儿6条'(索引有/文件无/抽不回) |
| B2 | 0.0245 | lesson | freebuff-proxy | 反向代理出站把官方 37 个工具合并进 tools，回程 CLIENT_TO_OFFICIAL_TOOL 仅覆盖 12 个，剩余 25 个（suggest_prompts、17 个 preview_* |
| （B 只返回 2 条） | | | | |

判断：**这句 B 的 top1 更好**。B1 正好是「同一错误重复犯」的 lesson。A2、A3 是没有信息量的短原话。不过两边都没解决真正的需求：这句 query 没说是哪个错误，真正有用的召回应当按**当前任务**推送相关 lesson，而不是按这句话的字面意思去匹配。两个通道都做不到这一点。

### q3 事实检索：「WsPxy-colo HX-CF-WsPxy 用这个做出口可以吗？」
| # | 分数 | kind | project | 内容 |
|---|---|---|---|---|
| A1 | 0.7410 cos | context | HX-Jungle | 请问是使用 cf 代理吗 （WsPxy-colo） |
| A2 | 0.6741 cos | lesson | HX-CF-WsPxy | HX-CF-WsPxy 出口策略化改造 (ad8c63c): ①云flare connect() 到 CF 自有网段被运行时拒(官方#21888 明确无开放计划), 且 connect() 只在 ho |
| A3 | 0.6697 cos | fact | HX-OutlookRegister | WsPxy 出口池上限实测 (2026-09-22, 会话 14): WsPxy 的唯一出口最多约 10 个, 全部落在 CF IPv4 段 104.28.0.0/16 (实测 32 个会话 / 30 |
| B1 | 0.2189 | pattern | HX-OutlookRegister | WsPxy 的 pin 只锁定入口 colo、不锁定出口，出口从共享池概率抽取且仅会话内粘性，故每窗口全新 IP 结构上无法保证；正式 10 轮全部 A5 403 失败。 |
| B2 | 0.2037 | pattern | HX-Jungle | 先把协议管线的稳定性/2FA 收尾， 然后开始存活率 和 保活（比如协议化的去github日榜单fork项目, commit自己项目之类的）作为课题，沉淀对应文档 同时接入 gh-r 这个服务中，最终 |
| B3 | 0.1859 | fact | HX-OutlookRegister | （与 A3 是同一条） |

判断：**B1 最直接回答了「能不能做出口」**：出口不锁定、每个窗口拿不到全新 IP、10 轮全部 403。A1 是用户自己以前问过的同一句话，没有答案。A2、A3 有用。综合看，A 有 2 条有用，B 有 2 条有用，但**最关键的那条只有 B 召回了**。这句打平，B 的 top1 略好。

### 小结（定性，3 句，不能外推）
- 3 句里，A 更好 1 句，B 的 top1 更好 1 句，打平 1 句。
- 这和 200 case 上「A 的 R@1 是 B 的 6 倍」**不一致**。
- A 的典型失败：召回语义相近但空洞的原话（context 类，比如「我已经重启，你可以继续」）。
- B 的典型失败：混入和主题无关的 pattern。

## 2 三问简答

**问 1：这个测试集对 naive 是否有结构性优势？**
有，但原因和质疑里说的不同。A 和 B 检索的是同一批抽取条目，不存在「naive 存原文、我们存提炼」的区别。真正的偏向有三点：
- 200 条全部来自同会话、同项目（同项目占比 1.0）。
- gold 里 73% 是 context 类（398/546），基本是用户原话；query 与 gold 的 bigram 重合度 p90 达到 1.0。
- gold 是「后续轮存下的条目」，属于启发式标注，没有人工判定相关性。

结果是测试奖励「语义贴近原话」，没有测跨会话、时间推理、知识更新这些能力。

**问 2：学术基准测什么，和我们差在哪？**
- LongMemEval：500 题，测 5 种能力（信息抽取、多会话推理、知识更新、时间推理、拒答），history 约 115k token，指标是**端到端答题正确率**（LLM 判分）。
- LoCoMo：长多会话对话上的单跳、多跳、时间、开放域问答。
- 我们测的是「同会话内检索 id 的 R@k」，没有阅读器，也没有跨会话题和更新题。

（来源见第 3 节）

**问 3：「naive 赢 6 倍」在什么前提下成立？**
成立的前提：同一语料；同会话后续轮作为 query；只算检索 R@k；B 是 H0（没有语义嵌入、带规则）；n=200，单个 seed。
以下情况不成立或未验证：
- 跨会话、隔天、知识更新的场景。
- 端到端答题质量。
- 规则遵守（规则应当主动注入，不靠 query 匹配）。

另外，定性 3 句里 B 的 top1 有 1 句更好，说明 6 倍不能代表实际使用效果。外部方面，Mem0 论文报告其结构化记忆在 LoCoMo 上高于最佳 RAG；但 2026-10 的一篇论文报告，原始历史 + dense + rerank 在 7 个设置中有 6 个排第一。两类结论都有，各自依赖设置。

## 3 来源
已打开：
- https://arxiv.org/abs/2610.30755 ：Raw-RAG（在原始历史上做 dense 检索 + rerank）在 LoCoMo、LongMemEval、MEME、MemoryAgentBench 的 7 个设置中有 6 个排第一，领先 0.13–5.53 分；摘要写到「即使完整访问转换后的记忆库，相对原始证据仍有准确率差距」。

只看过搜索摘录、没有打开全文：
- LongMemEval：https://arxiv.org/abs/2410.10813 ，https://xiaowu0162.github.io/long-mem-eval （500 题、5 种能力）
- Mem0 论文：https://arxiv.org/abs/2504.19413 。按 https://huggingface.co/datasets/rovemark/locomo-benchmark-results 的汇总，LoCoMo J 分数为：full-context 72.9，Mem0 66.9，Mem0g 68.4，Zep 66.0，最佳 RAG 61.0。
- Letta：https://www.letta.com/blog/benchmarking-ai-agent-memory 。filesystem 代理（grep + 向量）在 LoCoMo 上得 74.0%，并质疑 Mem0 对 MemGPT 的测法。
- Zep：https://arxiv.org/abs/2501.13956 。在 LongMemEval 上比 full-context 最多提高 18.5%。二手摘录 https://arxivsignals.io/papers/2501.13956 称其时间推理和多会话提升，single-session-assistant 下降。
- 各厂商的数字互相有争议（见 Letta 文章与 Mem0 的回应），不能直接比较。

查不到：小黑盒《大肥鱼》评测的正文（长图），其测法未知。
