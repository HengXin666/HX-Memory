# POLICY-FIX — 意图门控短路修复 (P0-1) + task-state「继续什么」(P0-3)

日期: 2026-11-03。按已查明根因实施, 未重新调查; 未改 intents.ts 正则, 未看评测集/面板/文档。

## 改了哪些文件

| 文件 | 位置 | 改动 |
|---|---|---|
| src/trigger/policy.ts | 144-162 `decide` | 只算 drift + detectIntent, 委托给决策核心 |
| src/trigger/policy.ts | 179-266 `decideFromSignals` (新) | 新短路顺序: 192 intent → 213 drift-refresh → 227 skip-similar → 243 always-on → skip-no-signal |
| tests/s1/trigger-policy.test.ts | 195-250 (新增 4 条) | intent 不被 always-on 吞 + 预算叠加 700; 账本 39 行回归; drift-refresh 在 hasAlwaysOn=true 时可达; decideFromSignals 与 decide 同口径 |
| src/kernel/task-continuation.ts | 新文件 1-92 | `isContinuationUtterance` (续接短句) + `findContinuation` (上一明确动作 / 涉及文件 / 未闭合失败) |
| src/kernel/task-state.ts | 7 import; 36-40 新字段; 208 errorContext; 232-243 confidenceOf 新语义; 346-361 续接计算; 377-380 goal | 新增字段 continuing / previousAction / previousTurn / previousFiles / blockedOn |
| tests/kernel/task-state.test.ts | 116-161, 193-199 | 改 3 条旧断言 (理由见下), 新增 3 条 |
| .hark-tmp/replay-policy.ts, .hark-tmp/next-demo.ts | 新 (临时) | 账本回放 + next 会话演示 |

### 新短路顺序 (policy.decideFromSignals)
1. 意图命中 → `mode=intent`, 预算 = intentBudget + (hasAlwaysOn ? alwaysOnBudget : 0)。always-on 是叠加: trigger-cache.recallFor 用 `budgetTokens - alwaysOnCost` 算意图召回预算, 不叠加的话 always-on 会吃光它。
2. 上一轮注入过且 drift ≥ 0.9 → `drift-refresh` (同样叠加)。
3. hasAlwaysOn 且上一轮注入过且 drift < 0.9, **无意图** → `skip-similar` (只在这里出现)。
4. hasAlwaysOn → `always-on` (首轮/从未注入)。
5. 其余 → `skip-no-signal`。

无 always-on 时行为与旧实现完全一致 (旧的 skip-no-signal 不会变成 skip-similar)。

### 改测试断言的说明 (改, 没删)
- 旧 trigger-policy 测试**没有一条**依赖 hasAlwaysOn 短路 (原 13 条全部原样通过), 只新增。
- task-state 「80 条历史 + yes/next → confidence ≤ 0.2, action 未知」: 旧断言把 confidence 当成「这句话信息量」。新语义是「对当前任务判断有多确定」。那段历史最后一个用户轮是明确任务 (新增…m19.py), 其后报错已被「已修改」闭合 → 改成断言 confidence ≥ 0.8、action=新增、previousFiles[0]=m19.py, 并保留原意「动作不来自当前轮」(`fromCurrentTurn` 不含 action)。
- 「噪声历史 + 嗯 → 0.1」改为「历史空白 + 嗯 → 0.1」, 保住「无从判断的短句低」这一档。

## 全量测试
- 改前基线: `npx vitest run` → code 0, **199 files / 1495 tests passed**
- P0-1 后: code 0, **199 / 1499 passed** (+4)
- P0-3 后: code 0, **199 / 1502 passed** (+3 净增; 另 3 条改断言)
- `scripts/verify-structure.ts`: 报 task-state.ts 与 task-continuation.ts 「悬空模块」— task-state.ts 本来就没接线 (改前即悬空), 没有登记进 ALLOWED_DANGLING_DIRS 去掩盖。
- `tsc --noEmit`: task-state.ts 173/186 `findLastIndex` 的 lib 报错是原有代码 (moduleOf/moduleFromCwd), 非本次引入。

## mode=intent 真的产生了 (不是只看单测)
回放真实触发账本 `~/.dsh/hx-memory/schedule/*.jsonl` (1800 行, 1744 行 trigger 判定), 走生产用的同一个决策核心 `decideFromSignals`, hasAlwaysOn=true (与线上一致)。
lastInjectedAt 由账本自身推断; 用旧逻辑复算记录的 mode: **1744/1744** 一致, 说明输入重建可信。

| | always-on | skip-similar | intent | drift-refresh |
|---|---|---|---|---|
| 账本记录 (旧) | 992 | 752 | 0 | 0 |
| 回放 (新) | 177 | 695 | **116** | 756 |

转移: {"always-on -> always-on": 177, "always-on -> drift-refresh": 756, "skip-similar -> skip-similar": 695, "always-on -> intent": 59, "skip-similar -> intent": 57}

- 命中 session-continuation 却没注入的行 (39 行 always-on/skipped + 4 行 skip-similar/skipped = 43): 新逻辑下 **43/43 判为 mode=intent, inject=true**。
- always-on → drift-refresh 756 行: 这些行旧逻辑也是注入的, 只是现在标成话题切换并给意图召回留出 300 token 预算; 注入次数不变。

直接用真实形状输入调 `decide` (hasAlwaysOn=true):
```
{"text":"接着做剩下的部分","mode":"intent","inject":true,"intent":"session-continuation","drift":0.44,"budget":700}
{"text":"我们上次为什么没用 Jaccard？","mode":"intent","inject":true,"intent":"recall-decision","drift":1,"budget":700}
{"text":"前端按钮圆角改成 8px","mode":"drift-refresh","inject":true,"intent":null,"drift":1,"budget":700}
{"text":"容器并发上限怎么设","mode":"skip-similar","inject":false,"intent":null,"drift":0.33,"budget":0}
{"text":"把这个函数重命名为 parseConfig","mode":"always-on","inject":true,"intent":null,"drift":1,"budget":400}
```

## ⚠ 没修完的部分 (如实)
账本那 39 行的 outcome=skipped **不是 policy 判的**: 当时 policy 已判 inject (mode=always-on), 是 prestep 的整块文本判重 (`prior.texts.has(injectedText)`) 发现块与之前完全相同而跳过 — 因为召回出来的就是同一批常驻条目, 记忆库里根本没有「继续什么」这条信息。
所以 P0-1 让 policy 正确判出 intent, 但要让用户说「继续」时真的推出「继续什么」, 还需要把 task-state 接进 prestep (把 goal/previousAction/blockedOn 并进同一个注入块)。
没接的原因: prestep 的 `payload.messages` 是本步 claimed 批次, 不是全量会话历史; 拿全量历史要走 session-events, 属于新的改动面, 按「不一次改所有东西」留到下一步。另外裸「继续/next/嗯」本身不命中任何意图 (不扩正则), 这条也只能靠 task-state 那条线兜住。

## 三个真实样例改前改后 (.hark-tmp/ts-sample.ts)
| 样例 | 用户原话 | 改前 action / confidence / goal | 改后 |
|---|---|---|---|
| 低信息 yes | `yes` | 未知 / 0.1 / goal=`最近报错 失败` | 新增 / 0.8 / previousAction=新增 / previousFiles[0]=`vendor/genspark2api/cookies/cookies_proto_1791645235.json` / blockedOn=null / goal=`继续上一任务「那你能不能强制进入呢？就比如说你用协议注册成功了，那你不是最终也得到1个浏览器凭」: 新增 vendor/genspark2api/cookies/cookies_p` |
| 修代理 | `你帮我修一下代理吧，让他自己能就是能控制` | 修改 / 0.4 / goal=`在 workspaces/browser-auto、tmp 修改, 最近报错 failed` | 修改 / 0.4 / previousAction=None / previousFiles[0]=`` / blockedOn=null / goal=`在 workspaces/browser-auto、tmp 修改, 最近报错 failed` |
| 低信息 next | `next` | 未知 / 0.1 / goal=`最近报错 Error` | 修改 / 0.8 / previousAction=修改 / previousFiles[0]=`workspaces/browser-auto/gmail-login/tools/fp_probe.py` / blockedOn=有 / goal=`继续上一任务「改好的东西，做好提交获取到远程，然后触发一下我配置的那些code review。」: 修改 workspaces/browser-auto/gmail-login/t` |

已知的偏差 (原有的 actionOf/lastError 词表问题, 本次未改):
- 「低信息 yes」previousTurn 找对了上一轮请求, 但 actionOf 子串匹配给出「新增」, 不太准。
- 「低信息 next」previousTurn 是「改好的东西, 做好提交…触发 code review」, 动作被「改」字判成「修改」(实际是提交+触发评审); blockedOn 是误报: 工具输出里一段源码含 `probe_error` 被 lastError 当成报错。

## 造的「用户说 next」会话 (.hark-tmp/next-demo.ts)
```
== 造的 next 会话 ==
{
 "userText": "next",
 "continuing": true,
 "action": "修改",
 "previousAction": "修改",
 "previousTurn": "把 src/trigger/policy.ts 里 decide 的短路顺序改掉, intent 命中不能被 always-on 吞",
 "previousFiles": [
  "src/trigger/policy.ts",
  "tests/s1/trigger-policy.test.ts",
  "src/kernel/binder.ts"
 ],
 "blockedOn": "failed: FAIL tests/s1/trigger-policy.test.ts > 去重 AssertionError: expected 'intent' to be 'skip-similar' Test Files 1 failed",
 "confidence": 0.8,
 "goal": "继续上一任务「把 src/trigger/policy.ts 里 decide 的短路顺序改掉」: 修改 src/trigger/policy.ts、tests/s1/trigger-policy.test.ts, 卡在 failed: FAIL tests/s1/trigger-policy.test.ts > 去重 AssertionE"
}
== 同一句 next, 历史空白 ==
{"previousAction":null,"confidence":0.1,"goal":""}
```
