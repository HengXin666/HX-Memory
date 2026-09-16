# Agent Note: 助手输出恒为空, 记忆只沉淀用户原话

Status: implemented

## Problem

用户反复反馈"沉淀的记忆内容总是我的输入"、"目前记忆好像没有什么价值"。实测证据:

- `~/.dsh/hx-memory/episodes/` 下 **315 条 episode 全部是 `role: user`**, 助手侧一条都没有。
- `capture/*.jsonl` 账本 36 行全部 `aChars: 0`, `enrichMs: 0` —— AI 结构化器**从未被调用成功过**。
- 114 条 active 记忆里 27 条 (`c*`) 是用户输入逐字转录, **全部没有 `conclusion`**;
  另有 10 条机器占位规则。

根因在 `runtime.textOf`: 宿主 `assistant/message` 的 `data` 是**信封**
`{ turn, step, message, usage, stream }`, 文本在 `data.message.content`;
而 `user/message` 才把消息展开在 `data` 上 (`content/source/role/id`)。
`textOf` 只读 `data.content`, 于是助手侧恒返回 `""`。

后果是连锁的: 没有 assistant 文本 → `input.answer` 恒为空 → 结构化器的提示词退化成
"只有问题" → `conclusion` 恒为空 → 要么被结论闸门丢弃, 要么把用户原话当记忆落盘。

**为什么长期没被发现**: `tests/s2/qa-pair-capture.test.ts` 等三处测试自己构造的载荷是
`data: { content: [...] }` —— 一个宿主从不发出的形状。测试与生产形状不一致,
把"助手输出恒为空"完整地放过了。

## Decision

1. `textOf` 改为先认 `data.content` (user/message 裸形状), 再回落 `data.message.content`
   (assistant/message 信封形状), 字符串与块数组两种都支持。
2. 块数组只取正文: 显式 `type !== "text"` 的块 (`reasoning` 思维链 / `tool-call`) 一律丢弃,
   缺 `type` 的块按正文处理。否则思维链会作为"回答"进 episode 并进一步变成记忆。
3. 三处测试的载荷改成**磁盘上真实的信封形状**, 并新增两个契约用例钉住它。

## Consequences

- 助手输出重新进入 episode 与 `{question, answer}` 配对, 结构化器拿到"回答"才能读出结论,
  记忆内容从"用户原话"变成提炼后的结论 —— 这是"记忆没有价值"的直接解药。
- 该修复**在宿主重启前不生效**: 运行中的进程仍用旧代码。
- 已存的历史数据不会被追溯修复: 315 条 user-only episode 可重放, 但重放需要 assistant 原文,
  而那份原文当时就没被记下来。历史条目按人工整理另行处置 (见下文)。
- `reasoning` 块被过滤, 思维链不会污染记忆。

## Alternatives considered

- **在 host 侧改 `assistant/message` 载荷**: 不可行, 那是宿主契约, 且 user/assistant 形状不一致
  是既有事实, 适配器本就该同时兼容两种。
- **只加 `data.message` 分支而不过滤块类型**: 已实测会把 "先想一想。" 这类思维链写成回答
  (本 note 的新用例第一次运行就抓到了), 必须过滤。
- **保留测试里的旧形状、另写一个生产形状用例**: 会让两套形状长期并存, 测试继续偏离生产;
  直接改正三处载荷才能消除"形状漂移"这个根因。
- **顺手加日志告警**: 不选。恒为空的字段不报错, 靠告警兜不住; 契约用例是更硬的闸门。

## 数据整理 (同次, 已备份)

备份: `/home/hx/.dsh/hx-memory-backup-2026-09-15T15-07-34/` (`index.sqlite` +
`hx-memory-files.tgz`, `PRAGMA integrity_check` = ok, 117 条记忆 / 17 条规则)。

经 `forget()` (写 `status: shadow`, 不物理删除, 可审计) 撤回 **37 条**:
27 条原始输入转录 + 10 条 `经验: … 已沉淀 …` 机器占位规则。
active 由 114 → 77, 全量 `rebuildFromFiles()` 后仍为 77 (**未复活**), 真规则 7 条保留。

占位规则的识别抽到 `kernel/rule-shape.ts` 单一事实源, 供触发器与整理脚本共用。
