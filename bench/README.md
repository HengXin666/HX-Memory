# 记忆系统对比测试骨架

目的: 用**同一批数据、同一套 case、同一个 LLM 与嵌入模型**, 对多个记忆系统做可复现的横向评测,
并给出带置信区间的结论 —— 而不是靠印象互相吹。
边界: 只做检索与抽取质量的量化; 不评测部署成本、许可证合规 (那些写在调研文档里)。
与代码的关系: 语料来自本仓库真实库 (经 `src/storage/truth-scan.ts` 只读导出);
被测系统之一是本仓库自身, 经 `src/app/stack.ts` 组装。

## 为什么需要它

自评没有意义: 本项目曾判断"图扩展提升关联召回", 实测图通道在真实库上**逐位无差别**
(库里只有 13 条边, 全是 `generalizes`); 也曾认为"接入真语义必然更好", 实测 R@1 从 0.519 掉到 0.186。
这些问题只有横向比较才暴露得出来。

## 目录

| 路径 | 作用 |
| --- | --- |
| `lib/corpus.ts` | 从真库只读导出中立语料 (与任何宿主/引擎无关的最小字段集) |
| `lib/cases.ts` | 生成分层 case (词面 / 多跳 / 时间更新 / 弃权) |
| `lib/eval_kit.py` | 指标 (Recall@k / MRR / nDCG@k) + 配对 bootstrap + McNemar + 样本量估算 |
| `runners/hxmem.ts` | 被测系统: 本仓库 (可切换通道组合) |
| `runners/mem0.py` | 被测系统: mem0 (raw / infer 两种模式) |
| `score.py` | 统一打分器: 所有系统同一口径, 输出对比表与显著性 |

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
