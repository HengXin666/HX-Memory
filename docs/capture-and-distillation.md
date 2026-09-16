# 记忆捕获与提炼

目的: 说明"一轮对话如何变成一条记忆", 以及记忆正文为什么是提炼结论而不是原话转录。
边界: 不写检索与排序 (见 `architecture.md`), 也不写推广与治理 (见 `adr.md` 的 ADR-003)。
与代码的关系: 捕获链路在 `src/capture/` (engine / pipeline / structurer), 宿主接线在 `src/adapters/dsh/`
(runtime = 事件状态机与冲刷; capture-ledger = 轮次配对与账本形状; capture-log = 耗时账本的落盘与汇总),
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

## 捕获花的时间去哪了

**捕获对宿主是异步的, 但异步不等于免费。** 三条事实叠在一起, 让"这一轮怎么比平时慢"成了必须能回答的问题:
捕获与对话跑在同一个进程、同一个 event loop 上; 它自己会调一次模型做结构化; 而 `node:sqlite` 的写入是同步的。

因此每一轮完成的对话都会在 `capture/YYYY-MM-DD.jsonl` 留一条记录 (与 `schedule/` 同构的追加式账本,
见 `adapters/dsh/capture-log.ts`): 结果 (stored / skipped / error)、跳过原因、原文与回答的字符数,
以及 **episode / 结构化 / 建边 / 落盘四段各自的毫秒数**。

一段不能省的话: 宿主没有"这一轮对话总共花了多久"的稳定接口, 所以 `totalMs` 记的是
**捕获在 `turn/end` 之后又占用了多久**, 它才是"记忆层拖慢下一轮"的可归因量 —— 把它读成端到端延迟是误读。

"跳过"的原因也在这里区分 (捕获关着 / subagent / 没形成问答 / 无信号 / 读不出结论):
它们此前在外部只表现为"库里的条数没变", 而处置方式恰好相反。

## 真相在哪里

原始问答逐字写在 `episodes/YYYY-MM-DD.jsonl` (追加写, 永不改写), 记忆条目通过 `derivedFrom`
指向对应的两条 episode。因此"正文是提炼"不削弱可审计性: 抽查与全量重放 (T2) 都能回到原文。
重放按 `(session, turn)` 配对后再抽取, 否则恢复出来的是旧行为 (问句转录)。
