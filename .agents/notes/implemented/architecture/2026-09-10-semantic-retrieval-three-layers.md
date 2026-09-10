# Agent Note: 语义检索分三层, 阈值由嵌入器自述, 预步预热有硬时限

Status: implemented

## Problem

用户实测的核心缺陷是"记忆只认精确匹配, 换个说法就找不到"。定位时发现两件事: (a) 词汇袋哈希嵌入对同义改写几乎无用 —— 实测同义改写 cos≈0.17、无关文本 cos≈0.08, 区分度太低, 等于没有语义能力; (b) 本机无法访问 HuggingFace, 无法把"下载 ONNX 模型"作为唯一路径。另外, 远端嵌入服务是异步的, 而 `agent/pre-step` 的注入判定是同步的 —— 直接引入 async 会让注入路径变形或拖慢对话。

## Decision

三种实现共用 `Embedder` 端口, 按环境自动选择:

1. **`LexicalEmbedder` (默认)**: 离线零依赖。同义词表归一 (上线/发版→发布, 兜底→熔断) + 字级 2/3-gram (中文换词不换字) + 英文轻量词形归一 (retries→retry)。实测同义 cos≈0.50 / 无关≈0.005。
2. **`OpenAiCompatibleEmbedder` (可选真语义)**: POST `{baseUrl}/embeddings` (覆盖 OpenAI/Ollama/vLLM/TEI/自建), 由 `HX_MEMORY_EMBEDDING_BASE_URL`/`MODEL` 启用; 它异步, 因此配 `ProjectedVectorIndex` 投影。
3. **`HashingEmbedder` (基线)**: 保留作对照与降级。

配套两条规则:

- **余弦下限 `floor` 由嵌入器自己声明**: 不同模型的相似度尺度完全不同 (词汇级 0.2-0.5, 真语义 0.7+), 全局阈值必然有一边失效。
- **预步注入的预热有硬时限**: `Binder.warm(deadlineMs, query)` 尽力补齐投影, 超时不报错; 预步默认最多等 50ms (可设 0), 未就绪时结果带 `vector:projection-warming` 降级说明。预热必须把**本轮查询**一起嵌入, 否则"文档就绪、查询未就绪"会让第一轮永远没有语义召回。

## Alternatives considered

**只做远端嵌入。** 语义质量最好, 但没网/没配置就完全没有语义能力, 且每轮注入都要等网络。作为可选升级层更合适。

**只做本地词汇袋 (现状基线)。** 实测区分度 0.17 vs 0.08, 对同义改写等于无效; 保留它只是作为对照, 不能作为默认。

**内置本地 ONNX 模型 (transformers.js 等)。** 真正的离线语义, 但实测本机无法访问模型站, 且引入原生依赖 (尝试安装时被 `sharp` 的 node-gyp 构建阻断), 与"零依赖内核"的取舍冲突。等有可验证的离线模型分发方式再考虑。

**每次注入同步等待嵌入服务。** 会把网络延迟直接加进对话延迟, 违背"记忆层不许拖慢对话"的既有约束。

## Consequences

同义改写 Recall@1 由 20% → 80%, Recall@3 由 20% → 100%, 无关查询仍为空; 离线即可用, 配了端点则升级为真语义。代价: 离线语义是**词典驱动**的, 词典覆盖不到的表达仍会漏 (需要在 `SYNONYM_GROUPS` 里补词); 远端路径最坏每轮多花 `warmupMs`。

## Testing

`tests/s1/embedding-lexical.test.ts` (逐条判定区分度, 不用平均值糊弄)、`tests/conformance/paraphrase-recall.test.ts` (先断言字面检索确实差, 再断言语义达标)、`tests/s2/embedding-http.test.ts` (stub 服务验证协议: 乱序响应/分批/超时/维度校验)、`tests/s2/semantic-prestep.test.ts` (硬时限不被空等突破)。评测与基准脚本: `scripts/eval-retrieval.ts`、`scripts/bench-retrieval.ts`。
