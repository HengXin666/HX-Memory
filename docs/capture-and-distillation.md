# 记忆捕获与提炼

目的: 说明"一轮对话如何变成一条记忆", 以及记忆正文为什么是提炼结论而不是原话转录。
边界: 不写检索与排序 (见 `architecture.md`), 也不写推广与治理 (见 `adr.md` 的 ADR-003)。
与代码的关系: 捕获链路在 `src/capture/` (engine / pipeline / structurer), 宿主接线在 `src/adapters/dsh/runtime.ts`,
抽取端口与重放在 `src/app/rebuild.ts`。

## 捕获单元: 一轮问答

一轮对话由 `user/message` + `assistant/message` + `turn/end` 组成。捕获器收全部三者, 并按
`(session, turn)` 把它们配成 `{question, answer}`。

助手输出必须一起收: 结论、理由与"为什么这么问"都长在回答里。历史版本只收 `user/message` 且把
episode 的 role 硬编码为 `user`, 结果是日志里没有任何助手侧内容, 记忆里 15% 是用户问句本身。

## 两道闸门

| 闸门 | 位置 | 判据 | 不通过时 |
| --- | --- | --- | --- |
| 结论闸门 | `capture/engine.ts` | 显式"记住 X" 永远放行; 问句且无回答且无结论信号 → 拦 | 不落盘, signal 记 `no-conclusion:question` |
| 提炼闸门 | `capture/pipeline.ts` | 问句开头的轮次, 结构化器必须给出 conclusion | 不落盘 (原文仍在 episode 里) |

只有问题、后面什么都没有的轮次没有可沉淀的结论, 存下来就是转录。自问自答 ("那就用 A 吧") 与
用户显式确认 ("采用/可以/就这样") 都算结论。

## 正文来自哪里

结构化器 (`TurnStructurer` 端口, 宿主注入 LLM 实现, 默认启发式兜底) 看 `{question, answer}` 并产出
`conclusion`。有 conclusion 时记忆正文就是它; 没有时正文保持原文 —— 失败不丢信息。

启发式兜底**刻意不产 conclusion**: 规则无法可靠判断"这一轮到底定没定", 产错结论会覆盖原文。

## 真相在哪里

原始问答逐字写在 `episodes/YYYY-MM-DD.jsonl` (追加写, 永不改写), 记忆条目通过 `derivedFrom`
指向对应的两条 episode。因此"正文是提炼"不削弱可审计性: 抽查与全量重放 (T2) 都能回到原文。
重放按 `(session, turn)` 配对后再抽取, 否则恢复出来的是旧行为 (问句转录)。
