# Agent Note: 记忆层从"转录"改为"提炼" (捕获单元 = 一轮问答)

Status: implemented

## Problem

真实库里 79 条记忆中, 12 条 (15%) 是用户**问句本身**; 对照 107 条 episode, 角色分布是 `{"user": 107}` ——
助手输出一条都没进过日志。也就是说, "记忆"这一层存的是"我问了什么", 而不是"最后定了什么、为什么"。

根因有三处, 都是设计取舍而不是 bug:

1. `adapters/dsh/runtime.ts` 只监听 `user/message`, 写 episode 时 role 硬编码为 `"user"` ——
   助手的输出根本没有入口。
2. `capture/engine.ts` 把"用户那一句"直接当记忆正文 (`content = explicit ?? text`), 用正则猜 kind
   (问句里出现"采用/选择/修复"就判成 decision)。
3. `capture/pipeline.ts` 里 AI 结构化只写旁挂字段 `structured`, 永不改正文; 且喂给它的是
   **只有问题、没有回答**的文本 —— 它被要求总结一个它看不到答案的问题。

第 3 条是关键: 结论与理由长在回答里, 抽取器却拿不到回答。这解释了为什么"沉淀的全是用户原话"。

## Decision

捕获单元从"一句用户输入"改为"一轮问答", 记忆正文从**转录**改为**提炼**。现在是这样:

- `runtime.ts` 同时收 `assistant/message`; 一轮写两条 episode (真实 role, 共用同一个 `turn` 序号),
  记忆吃 `{question, answer}`。
- `engine.ts` 有结论闸门: 只有问题、后面什么都没有的轮次直接拦下 (signal 记 `no-conclusion:question`);
  带回答的疑问句放行给结构化器判定; 自问自答与显式确认 ("采用/可以/就这样") 也算结论。
- `StructuredTurn` 有 `conclusion` 字段。有它时记忆正文就是结论, 没有时正文保持原文。
- `derivedFrom` 同时指向用户与助手两条 episode; `RebuildService` 的 T2 重放按 `(session, turn)`
  配对后再抽取。
- 启发式兜底刻意不产 `conclusion`: 规则无法可靠判断"这一轮到底定没定", 产错结论会覆盖原文,
  因此无模型时行为退回旧版 (不劣化也不改善)。

## Alternatives considered

**只在 prompt 里要求"总结用户的话"。** 不解决问题: 答案不在输入里, 模型无从总结, 产出的仍是问句的压缩。

**保留正文为原文, 只把结论写进 `structured.conclusion`。** 检索与注入读的是 `content`, 结论进不了检索面,
等于没改; 实测当前 `structured` 填充率只有 13%, 旁挂字段本就容易被忽略。

**每轮都沉淀助手输出。** 会把助手自己的臆测与错误也固化成记忆, 比现状更糟。因此必须有结论闸门:
用户显式确认或事情落地 (修好/跑通) 才算结论; 结构化器读不出结论就不落盘。

## Consequences

- 记忆条目的正文不再等于原文。原文逐字留在 episode 日志里 (追加写, 永不改写), 条目通过
  `derivedFrom` 指回, 因此抽查与全量重放都能回到真相 —— 变的是提炼层, 不是真相层。
- 助手输出从"完全不进记忆面"变成"经闸门筛选后进记忆面"。风险是助手自己的臆测被固化,
  缓解手段是结论闸门加结构化器的"没有结论就留空"。
- 记忆质量的上限由结构化器质量决定。宿主不接 LLM 时 (启发式兜底) 等于维持旧行为。
- 既有历史条目仍是转录形态, 不会自动重写; 需要时按 T2 重放 (配对逻辑已就绪) 或人工整理。
- 一轮问答多写一条 episode, 日志体积约翻倍, 保留期策略 (`episodeRetentionDays`) 的清理口径不变。

## Testing

- `tests/s1/capture-conclusion.test.ts`: 问句无回答不落盘; 问句带回答放行; 自问自答放行;
  显式"记住"永远放行; `episodeIds` 全量进 `derivedFrom`。
- `tests/s2/conclusion-pipeline.test.ts`: 有 conclusion 时正文是结论; 无 conclusion 时正文是原文;
  结构化器抛错时原样落盘。
- `tests/s2/qa-pair-capture.test.ts`: 一轮写两条 episode 且 role 正确; 两条共享 turn 序号;
  血缘指向两条; 讨论不出结论的轮次不落盘但原文仍在。
- 全量 `vitest run` 92 文件 / 659 用例全绿; `tsc --noEmit` 无错误; `verify-structure` 与 `verify-docs` 通过。
