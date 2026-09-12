# 记忆系统横向评测报告

目的: 记录"同一批数据、同一套 case、同一 LLM 与嵌入模型"下, 本仓库与几个开源记忆系统的实测对比。
边界: 只覆盖**检索质量**与**抽取噪声**两个面; 不评部署成本与许可证合规 (见 `open-source-landscape.md`)。
与代码的关系: 骨架在 `bench/`; 被测系统之一是本仓库 (经 `src/app/stack.ts` 组装)。

> [!NOTE] 未实现: 端到端问答轴 (原始对话 → 问答准确率) 尚未开跑, 需要 LLM judge 与更大 case 集。

## 一、被测系统

| 系统 | 版本 | 许可证 | 接入方式 |
| --- | --- | --- | --- |
| HX-Memory (本仓库) | 0.1.0 | Apache-2.0 | `bench/runners/hxmem.ts`, 5 个通道变体 |
| mem0 | mem0ai 2.0.20 | Apache-2.0 | `bench/runners/mem0_system.py`, raw 与 infer 两种模式 |
| Basic Memory | 0.22.1 | **AGPL-3.0** | `bench/runners/basic_memory.py`, 逐条 markdown note + FTS |
| Graphiti | graphiti-core 0.30.2 | Apache-2.0 (图库 FalkorDB Lite 嵌入式) | `bench/runners/graphiti_system.py`, **未完成, 见下** |

同义改写 case 由 `bench/lib/paraphrase.py` 用真实 LLM 生成, 并要求与原文的字符 bigram
重合度低于 0.35 (实测平均 0.11) —— 这是唯一能体现"语义 vs 词面"差距的一层。

受控变量: 同一个 LLM (经本地代理指向同一上游模型) 与同一个嵌入模型 (本地 bge-small-zh-v1.5, 512 维)。
所有系统由 `bench/score.py` 用**同一个打分函数**计算, 按源条目去重, 弃权类单独统计。

## 二、语料与 case

语料: 从真实记忆库只读导出 **80 条** (排除 shadow)。case: **171 个**, 五层 ——
唯一子串 67 / 共享词面 53 / **同义改写 40** / 多跳 6 / 弃权 5。

case 是**机器生成且可验证**的: 词面探针用"在全库中唯一"判定, 弃权类的关键词经词边界校验确认不出现,
同义改写的字面重合度由 bigram 阈值卡住。

## 三、结果 (k=10, recall 口径)

含 171 个 case (含 40 条同义改写):

| 系统 | R@1 | R@5 | R@10 | MRR | nDCG@10 |
| --- | --- | --- | --- | --- | --- |
| **A 纯词面 (本仓库, 无向量无图)** | **0.684** | 0.919 | 0.947 | **0.875** | **0.884** |
| B 哈希近似语义 | 0.580 | 0.869 | 0.926 | 0.789 | 0.816 |
| D 真语义 (bge) | 0.577 | 0.879 | **0.956** | 0.789 | 0.823 |
| C 哈希语义 + 图扩展 | 0.548 | 0.869 | 0.928 | 0.770 | 0.803 |
| mem0 raw | 0.583 | 0.860 | 0.919 | 0.792 | 0.811 |
| E 真语义 + 图扩展 | 0.529 | 0.865 | 0.944 | 0.758 | 0.796 |
| basic-memory (text) | 0.349 | 0.581 | 0.663 | 0.548 | 0.567 |

**分层看才有意义** (recall@10):

| 系统 | 唯一子串 | 共享词面 | 同义改写 | 多跳 |
| --- | --- | --- | --- | --- |
| A 纯词面 | 0.985 | 0.986 | 0.825 | 1.000 |
| B 哈希近似语义 | 0.985 | 0.976 | 0.750 | 1.000 |
| D 真语义 | 0.985 | 0.958 | **0.900** | 1.000 |
| mem0 raw | 0.955 | 0.917 | 0.850 | 1.000 |

## 四、结论

1. **语义通道的价值只在同义改写层显现, 且是本仓库内部唯一在这层领先的变体。**
   D 真语义 0.900 vs A 纯词面 0.825 vs B 哈希近似语义 0.750。注意 B 反而**低于** A ——
   哈希袋嵌入 (词袋近似) 在同义改写上不是"更差一点", 而是主动引入噪声。
   这条把之前的结论纠正了: 不是"语义无用", 而是**哈希近似语义有害、真语义有效**。
2. **真语义的总分仍低于纯词面, 原因是它牺牲了词面层。** D 在共享词面上 0.958 vs A 0.986。
   要两头都要, 需要按 case 难度自适应融合, 而不是固定权重 —— 这是后续工作。
3. **本仓库的图扩展在当前数据上逐位无差别, 甚至有害。** 语料只有 13 条边且全是 `generalizes`,
   规则本身字面就可命中; E 还把多跳从 1.000 拉到 0.667。要让图有价值, 必须先让写入路径
   产出边 (当前 `entities` 填充率 0%)。
4. **basic-memory 全面落后** (R@1 0.349), 弱项在共享词面与同义改写。它把每条 note 当整体索引,
   长文本里的细粒度匹配不占优。
5. **所有系统在弃权上都失败**, 没有系统会说"我不知道"。这是共同短板, 不是某一家的问题。

## 四之二、Graphiti: 接了但没跑完 (这本身是结论)

Graphiti 的适配器已完成并**部分**跑通, 但**没有**进入上表 —— 因为它在合理时间内跑不完:

- 单条写入约 **20 秒** (每条要一次 LLM 抽取 + 建实体/边 + 社区处理)。80 条语料仅写入就要 ~27 分钟,
  之后 171 个 case 的检索还要逐个走 **cross-encoder 重排 (又是一次 LLM 调用)**。
- 整个流程跑了约 **50 分钟仍未结束**, 已终止。终止时数据库已 2.3 MB, 说明它确实在抽取, 不是卡死。
- 作为对照, 同一份语料: 本仓库 (确定性抽取) 秒级完成, mem0 raw 2 秒, basic-memory 一次性 reindex。

已确认可用的接入要点 (写进适配器注释, 供后续复用):

| 坑 | 现象 | 解法 |
| --- | --- | --- |
| 上游挡 UA | 403 Cloudflare 1010 | 走本地注入 UA 的代理 |
| 需要真 key | 401 INVALID_API_KEY | 代理会透传 Authorization, 必须给真实 key |
| 构造时自动建 reranker | 缺 key 直接抛 `OpenAIError` | 显式传 `OpenAIRerankerClient` |
| 结构化输出 | 400 "response_format type is unavailable" | `OpenAIGenericClient(structured_output_mode="json_object")` |
| `reference_time` 类型 | `'str' object has no attribute 'isoformat'` | 传 `datetime`, 不是 ISO 字符串 |
| 检索返回**边**不是原文 | 事实是改写过的文本, 无法直接对回源条目 | 用 `edge.episodes` 里的 episode uuid 反查源 id |

**抽取质量的非正式观察** (样本小, 仅作方向): 英文实体丰富的事实 (Alice works at Acme Corp...)
抽出 2 节点 1 边; 中文**实体型**事实 (张伟在北京的 Acme 公司担任软件工程师) 抽出 3 节点 3 边;
而中文**抽象陈述型** (如"派生索引必须可全量重建") 抽出 1 节点 0 边 —— 抽象经验类记忆
在知识图谱形态下会退化成孤立节点。这正好是本仓库 `entities` 填充率 0% 的镜像问题。

## 五、必须声明的边界

- **样本量不足**: >1000 题才有统计效力 (Miller 2024, arXiv:2411.00640); 131 题只能算内部消融。
- **池化偏差**: gold 由本仓库内容派生, 对词面检索有利; 换系统时须重新独立生成 gold。
- **只有一条轴**: 端到端问答未测; 那条轴上"人工沉淀 vs LLM 抽取"是不可控混杂, 必须单独报。
- **case 类型失衡**: 唯一子串占 39%, 而它是最容易的一层 (所有系统都在 0.95 以上),
  会把各系统之间的真实差距稀释掉 —— 分层数字比总分更可信。
- **同义改写的 gold 单一**: 每条只有一个目标条目, 无法区分"召回了相关但非唯一答案"。
- **Graphiti 缺席**: 它没跑完, 因此上表**不能**被读成"Graphiti 效果差" —— 它只是成本高到
  不适合这个规模的批量评测。结论只覆盖表内三个系统。
- **写入成本未列为指标**: 本轮只在 Graphiti 上暴露出来; 后续应把"建立索引的墙钟时间"
  作为一等指标记录 (它决定了系统能否用于日常沉淀)。

## 六、复现

```bash
python3 bench/serve/embed_server.py &     # 本地嵌入 (bge-small-zh)
python3 bench/serve/llm_proxy.py &        # LLM 代理 (注入 UA)
node --experimental-strip-types bench/lib/corpus.ts
node --experimental-strip-types bench/lib/cases.ts
node --experimental-strip-types bench/runners/hxmem.ts --out .tmp/bench/hxmem-runs.json
python3 bench/runners/mem0_system.py --out .tmp/bench/mem0-raw-runs.json
python3 bench/runners/basic_memory.py --mode text --out .tmp/bench/bm-text-runs.json
python3 bench/score.py --runs .tmp/bench/hxmem-runs.json --runs .tmp/bench/mem0-raw-runs.json --runs .tmp/bench/bm-text-runs.json
```