# CHECKPOINT（2026-11-03 01:25 CST）

## 已完成
- task-state.ts 第 2 版：15 个单测通过（TASK-STATE-FIX.md）。用户已指出这一版方向反了：yes/next 时 confidence 被压低。
- P0-1 根因已查清，写在 TASK-DRIVEN-FIX.md：policy.ts:155 只要 hasAlwaysOn 就提前返回，通道 2（intent）和通道 3（drift）不可达。schedule 日志里 112 行意图命中全部落在 always-on 或 skip-similar 两个 mode 下。

## 正在做
- 无（额度耗尽，停在可交付处）。

## 下一步（按用户 2026-11-03 01:21 的优先级）
1. P0-1 修复：调整 policy.decide 的顺序，intent 命中时优先，不被 hasAlwaysOn 或 skip-similar 吞掉。改完跑 `npx vitest run`，修相关测试；用 node 26 复跑贴输出。
2. P0-3：task-state 增加「继续什么」。从历史里找最近一次 action 不是「未知」的轮次，输出 { action, files, 卡点 = 那之后还没解决的失败 }。
3. P0-2：重新定义 confidence，含义是「我对当前任务的判断有多确定」。用户说 next 但历史有明确任务时要高；有具体任务但历史空白时为中；两者都没有时为低。禁止按字数压低。现在 task-state.ts 的 confidenceOf 正是按字数压低，要改掉，对应单测（回归 yes/next 要求 ≤0.2 的那两条）也要反过来改。
4. P0-4：只算 always-on 组的净值，口径用 M2 加安慰剂对照。
5. P0-1 和 P0-3 都做完后，PUT 更新 TASK-DRIVEN-FIX.md。

## 已知坑
- 不要扩 intents.ts 的正则；不要看评测集、面板和文档。机器资源用 `taskset -c 0-3 nice -n 19`。
- 宿主 exec 用管道会吞掉退出码，vitest 要直接跑。
- task-state 的 error 关键词是子串匹配，会误报，比如 probe_error；/tmp 会被当成模块。
- 未提交的文件：src/kernel/task-state.ts、tests/kernel/task-state.test.ts、bench/naive-vs-hybrid.ts、bench/qualitative.ts。
- 通道、token 和资源纪律见 project-doc 技能；token 不要写进文档。
