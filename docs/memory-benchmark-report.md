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

受控变量: 同一个 LLM (经本地代理指向同一上游模型) 与同一个嵌入模型 (本地 bge-small-zh-v1.5, 512 维)。
所有系统由 `bench/score.py` 用**同一个打分函数**计算, 按源条目去重, 弃权类单独统计。

## 二、语料与 case

语料: 从真实记忆库只读导出 **80 条** (排除 shadow)。case: **131 个**, 五层 ——
唯一子串 67 / 共享词面 53 / 多跳 6 / 弃权 5。

case 是**机器生成且可验证**的: 词面探针用"在全库中唯一"判定, 弃权类的关键词经词边界校验确认不出现。

## 三、结果 (k=10, recall 口径)

| 系统 | R@1 | R@5 | R@10 | MRR | nDCG@10 |
| --- | --- | --- | --- | --- | --- |
| **A 纯词面 (本仓库, 无向量无图)** | **0.726** | **0.965** | **0.986** | **0.950** | **0.948** |
| B 哈希近似语义 | 0.661 | 0.939 | 0.982 | 0.891 | 0.905 |
| C 哈希语义 + 图扩展 | 0.619 | 0.939 | 0.984 | 0.866 | 0.889 |
| D 真语义 (bge) | 0.617 | 0.912 | 0.974 | 0.851 | 0.872 |
| E 真语义 + 图扩展 | 0.554 | 0.894 | 0.958 | 0.811 | 0.837 |
| mem0 raw | 0.657 | 0.919 | 0.941 | 0.889 | 0.887 |
| basic-memory (text) | 0.429 | 0.726 | 0.786 | 0.677 | 0.692 |

配对 bootstrap (recall@10): 本仓库纯词面显著优于 basic-memory (Δ=+0.200, CI [+0.134,+0.271]);
与 mem0 raw 的差距不显著。

## 四、结论

1. **在这套 case 上, 词面检索就是最强基线。** 它打败了所有"更聪明"的变体 —— 包括本仓库自己的
   语义通道与图扩展。这符合方法论常识: 词面探针天然偏爱 FTS, 因此**不能**据此断言"语义无用"。
   case 集里没有真正的同义改写, 这是当前评测最大的结构性缺陷。
2. **本仓库的图扩展在当前数据上逐位无差别。** 语料只有 13 条边且全是 `generalizes`,
   而规则本身字面就可命中 —— 图通道没有额外信息可加。要让图有价值, 必须先让写入路径产出边
   (当前 `entities` 填充率 0%)。
3. **basic-memory 的弱项在多跳与唯一子串**, 强项在共享词面。它把每条 note 当整体索引,
   长文本里的细粒度子串匹配不占优。
4. **所有系统在弃权上都失败** (除个别 case 返回 5-6 条), 没有系统会说"我不知道"。
   这是共同短板, 不是某一家的问题。

## 五、必须声明的边界

- **样本量不足**: >1000 题才有统计效力 (Miller 2024, arXiv:2411.00640); 131 题只能算内部消融。
- **池化偏差**: gold 由本仓库内容派生, 对词面检索有利; 换系统时须重新独立生成 gold。
- **只有一条轴**: 端到端问答未测; 那条轴上"人工沉淀 vs LLM 抽取"是不可控混杂, 必须单独报。
- **case 类型失衡**: 唯一子串占 51%, 而它是最容易的一层 (所有系统都在 0.95 以上)。

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
