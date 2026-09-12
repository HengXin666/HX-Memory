# 记忆系统对比测试骨架

目的: 用**同一批数据、同一套 case、同一个 LLM 与嵌入模型**, 对多个记忆系统做可复现的横向评测,
并给出带置信区间的结论 —— 而不是靠印象互相吹。
边界: 只做检索与抽取质量的量化; 不评测部署成本、许可证合规 (那些写在调研文档里)。
与代码的关系: 语料来自本仓库真实库 (经 `src/storage/truth-scan.ts` 只读导出);
被测系统之一是本仓库自身, 经 `src/app/stack.ts` 组装。

## 为什么需要它

自评没有意义。本骨架已实测出三个**靠自省得不出**的结论:

- "接入真语义必然更好"是错的 —— 但真正的原因是排序缺陷 (**MMR 的挑选顺序被当排名返回**),
  不是语义本身; 修掉后 R@1 从 0.099 回到 0.617。**没有外部对照就不会去查这一层。**
- "图扩展提升关联召回"只在一半场景成立 —— 用全体平均分看它是负收益 (精确率仅 8.5%),
  用"必须靠边才能答对"的 case 看它有明确收益 (0.250 → 0.750)。**指标定义决定结论方向。**
- 当前语料规模下 **"不检索也答得对"** (80 条仅 16.5K tokens, 32K 上下文全装得下)。

## 目录

| 路径 | 作用 |
| --- | --- |
| `lib/corpus.ts` | 从真库只读导出中立语料 (与任何宿主/引擎无关的最小字段集) |
| `lib/cases.ts` | 生成分层 case (唯一子串 / 共享词面 / 多跳 / 时间更新 / 弃权) |
| `lib/paraphrase.py` | 用真 LLM 生成**同义改写** case (唯一能体现语义价值的一层) |
| `lib/graph-cases.ts` | 生成"必须靠边才能答对"的 case (公平衡量图扩展) |
| `lib/scale-corpus.ts` | 规模压力语料 (真实条目 + 显式标注的合成干扰项) |
| `lib/eval_kit.py` | 指标 (Recall@k / MRR / nDCG@k) + 配对 bootstrap + McNemar + 样本量估算 |
| `lib/full_context.py` | 全上下文笨基线: 语料多小才"不检索也够用" |
| `lib/cost_quality.py` | 每系统每次查询的实际 token 成本 |
| `runners/hxmem.ts` | 被测系统: 本仓库 (可切换通道组合) |
| `runners/mem0_system.py` | 被测系统: mem0 (raw / infer 两种模式) |
| `runners/basic_memory.py` | 被测系统: Basic Memory (markdown note + FTS) |
| `score.py` | 统一打分器: 所有系统同一口径, 输出对比表与显著性 |
| `serve/embed_server.py` | 本地 bge-small-zh 嵌入服务 (受控变量: 所有系统共用同一模型) |
| `serve/llm_proxy.py` | LLM 代理 (上游挡非浏览器 UA, 这里注入 UA 后转发) |
| `snapshot.ts` | 指标快照: 防报告数字静默过期 |

### 为什么外部系统只有两个

曾接入 **Graphiti**, 实测单条写入约 **20 秒** (每条一次 LLM 抽取 + 建实体边 + 社区处理),
80 条语料写入就 ~27 分钟, 检索还要逐条走 cross-encoder 重排; 跑 50 分钟未完成, 已终止并**移出范围**。
它的接入坑保留在 `docs/memory-benchmark-report.md` §4.2, runner 已删除 ——
把它放进同一套本地评测会让"跑一遍全量对比"从分钟级变成小时级。

## 使用

```bash
# 0) 依赖: 本地嵌入服务 (bge-small-zh) 与 LLM 代理 (上游挡非浏览器 UA, 需注入)
python3 bench/serve/embed_server.py &
python3 bench/serve/llm_proxy.py &

# 1) 导出语料与 case (只读真库, 产物落在 .tmp/bench/)
node --experimental-strip-types bench/lib/corpus.ts
node --experimental-strip-types bench/lib/cases.ts

# 2) 跑各系统
node --experimental-strip-types bench/runners/hxmem.ts
python3 bench/runners/mem0_system.py

# 3) 统一打分
python3 bench/score.py
```

## 受控变量 (不做就会得出假结论)

- **同一个 LLM**: 所有需要抽取的系统走同一个上游模型 (经本地代理, 注入 UA)。
- **同一个嵌入模型**: 本地 bge-small-zh-v1.5 (512 维), 经 OpenAI 兼容端点。
- **同一个打分器**: 检索指标只在有 gold 的 case 上算, 弃权类单独统计;
  同一源条目重复命中去重 (mem0 的 LLM 抽取会把一条源条目拆成多条, 不去重会让 nDCG 重复计分)。
- **两条轴分开报**: retrieval-only (吃同一份语料) 与 end-to-end (从原始对话到问答) 不可混谈 ——
  前者公平, 后者有"人工沉淀 vs LLM 抽取"的不可控混杂。

## 必须声明的边界

- 样本量: 文献要求 **≈1000 题**才能声称"普遍更优" (Miller 2024, arXiv:2411.00640);
  当前 case 数量不足时, 结论只能算**内部消融/定性**, 不能算证明。
- 池化偏差: gold 若只从"本系统能检索到的条目"里挑, 就是给本系统建池, 系统性偏袒它。
  gold 必须独立生成, 并永远保留一个"笨基线" (纯 FTS5 / full-context) —— 如果笨基线赢了,
  说明 benchmark 没测到东西。
- 公开数字不可直接比: 各家 harness 的 top-k、judge、token 预算、子集都不同;
  mem0 论文的 LoCoMo 分数来自 SaaS 平台而非 OSS, 且维护者承认数字已变。

## 隐私

语料与打分产物含**真实记忆原文**, 一律写到 `.tmp/bench/` (gitignore 已排除), **永不提交**。
本目录只放工具与文档。
