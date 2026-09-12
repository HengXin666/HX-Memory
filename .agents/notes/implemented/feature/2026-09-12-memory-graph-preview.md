# Agent Note: 记忆关系图预览 (单文件 HTML) + 评测补 H@k

Status: implemented

## Problem

两件事都需要一个"可被人直接看见"的证据, 而不是只看数字。

一、**关系密度无法直观判断**。库里有 `relations` 字段与 11 种边类型, 但"到底连成什么样"只能靠
聚合数字猜。实测导出后发现: 80 条记忆中 **56 条完全孤立**, 边只有 `generalizes` 一种 ——
这类结论用表格列不出来, 必须看得见。

二、**单一 recall 指标会误导**。`R@k` 在多 gold 的 case 上按比例计分 (3 个 gold 只召回 1 个 = 0.33),
但"答对了"这件事没有体现。实测 basic-memory 的共享词面 `R@10` 0.672, 而它的 `H@10` 也是 0.672;
本仓库同层两者接近但含义不同 —— 只看一个会得出片面结论。

## Decision

- `scripts/graph-preview.ts` + `scripts/lib/graph-view.html`: 读**真相文件** (复用
  `storage/truth-scan.ts` 的去重口径), 生成一个自包含的 HTML —— canvas 力导向, 零外部依赖,
  零构建步骤, 双击即看。支持按类型/作用域/项目/状态着色, 词面搜索, 点节点看详情,
  图例当过滤器用。
- `npm run graph:preview` 调用; 产出默认落 `.tmp/memory-graph.html`。
- `bench/score.py` 增加 `H@k` 与 `R@k` 并列输出, 分层表同时给出两个口径。

## Alternatives considered

**引入图形库 (d3 / vis.js)。** 与本仓库"不整包引入"的既定取舍冲突, 且需要 CDN 或打包步骤 ——
离线单文件是它的核心价值 (能直接发给别人看)。

**做成 HTTP 服务或 DSH 面板。** 那是产品形态, 需要处理鉴权、CORS 与宿主适配; 当前需求只是
"先看看长什么样", 单文件是成本最低的形态。真正的对外接口留给后续设计。

**只加 H@k 不加 R@k。** 两者回答不同问题: `H@k` 是"有没有答对", `R@k` 是"答全了没"。
在多 gold 的 case 上必须并列, 否则任何单一口径都可以被挑选成结论。

## Consequences

- 预览工具是**只读**的: 不写记忆、不碰索引、不起服务。产物含真实记忆原文, 因此默认落 `.tmp/`
  (gitignore 内), 永不提交。
- 图的数据来自 `MemoryEntry.relations`, 因此它显示的**就是**检索图扩展能用的边 —— 库里
  `entities` 填充率 0%、边只有 `generalizes` 时, 图会诚实地表现为一堆孤立点。
- `H@k` 加入了打分器输出, 既有评测结论的数字不变 (新增列, 不改原有计算)。

## Testing

- `npm run graph:preview` 在真实库上产出 117 KB HTML; 用无头 Chromium 验证 JS 执行完成
  (图例 13 项、色块 11 个) 且 canvas 确实绘制 (非背景像素 5358)。
- `bench/score.py` 在 171 个 case 上重跑, `H@k` 与 `R@k` 分层数字一致可解释。
- 全量 `vitest run`: 679 用例全绿; `verify-structure` / `verify-docs` 通过。
