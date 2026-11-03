# TASK-DRIVEN-FIX（2026-11-03 01:25 CST）

## P0-1 为什么线上 mode=intent 是 0
### 结论
detectIntent 是命中的，但命中之后被 policy 抢先返回，接线本身没问题。
在 `src/trigger/policy.ts:155`，只要 `input.hasAlwaysOn` 为真，就直接返回 `always-on` 或 `skip-similar`，代码根本走不到第 184 行的「通道 2：意图门控」和第 204 行的「通道 3：话题切换」。
`src/kernel/binder.ts:279` 的 `hasAlwaysOn = alwaysOnIds.length > 0`。线上一直有跨项目规则，所以 hasAlwaysOn 恒为真，intent 和 drift-refresh 两个 mode 在结构上不可能出现。

### 证据
命令：`python3 .hark-tmp/sched.py`（读 ~/.dsh/hx-memory/schedule/*.jsonl），code 0
```
rows 1800 {'always-on': 992, 'skip-similar': 752, None: 56}
intent!=null by (mode,intent,outcome): {('always-on', 'session-continuation', 'skipped'): 39, ('skip-similar', 'recall-decision', 'skipped'): 36, ('always-on', 'recall-decision', 'injected'): 9, ('skip-similar', 'pitfall-avoidance', 'skipped'): 5, ('always-on', 'session-continuation', 'injected'): 4, ...}
```
- intent 字段非空的有 112 行，说明 detectIntent 确实命中过。
- 其中 mode=skip-similar 且 outcome=skipped 的有 52 行：意图命中了，却因为「同话题、上一轮注入过」被整体跳过。
- mode=always-on、intent=session-continuation、outcome=skipped 的有 39 行：命中了「继续」类意图，但 always-on 条目已经注入过、被判重，又没有意图召回补上，结果什么都没注入。

### 改法（未实施）
在 policy.decide 里，intent 命中时不能被 hasAlwaysOn 吞掉。具体是：先判断 intent，命中就以 mode=intent 注入，always-on 只作为叠加，预算在 trigger-cache 里扣；skip-similar 只用于「没有意图命中」的同话题轮次。
注意：改动会影响 tests/ 下现有的 policy 和 trigger 相关测试，本轮额度不够，没有改也没有跑。

## P0-3 让 task-state 回答「继续什么」
未开始，额度不够。见 CHECKPOINT.md 的「下一步」。
