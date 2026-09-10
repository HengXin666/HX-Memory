---
name: hx-memory-trigger
description: 排查"AI 没有查记忆"或"记忆没生效"类问题: 判断是触发层没命中、注入被去重、还是检索没召回。当用户报告记忆不生效、该搜不搜、面板改设置不生效或注入噪声过多时使用。
---

# 记忆触发排查

## 先看触发决策 (而不是先怀疑检索)

每一轮注入都留下 `TriggerDecision` (`src/trigger/policy.ts`), 字段:
`inject / intent / confidence / topicDrift / mode / reason / budgetTokens`。

按 `mode` 判断问题在哪:

| mode             | 含义                                     | 若结果不符预期, 检查                                     |
| ---------------- | ---------------------------------------- | -------------------------------------------------------- |
| `always-on`      | 保底通道注入 (已确认规则 + 项目关键事实) | always-on 缓存是否已预热 (`Binder.warm`); 预算是否被截断 |
| `intent`         | 命中回忆型提问句式                       | 句式是否覆盖该表达 → 扩 `DEFAULT_INTENTS`                |
| `drift-refresh`  | 话题切换后强制重查                       | 漂移度量 (`topicDriftOf`) 是否把同话题误判成切换         |
| `skip-similar`   | 同话题且刚注入过 → 跳过                  | 是否真的同话题; 阈值 `driftThreshold` (默认 0.8)         |
| `skip-no-signal` | 无保底 + 无意图 + 未换话题 → 不注入      | 是否需要为该项目配绑定, 或补一条意图                     |

## 常见根因 (按顺序查)

1. **项目没配绑定**: 绑定通道空 → 走通用触发通道 (always-on + 意图)。若连 always-on 也为空,
   说明库里没有**已确认规则**或本项目关键事实 —— 这属于"确实没内容", 不是 bug。
2. **意图没命中**: 提问形状不在库里 → 加一条 pattern (优先匹配句式, 不要加知识关键词)。
3. **注入被去重**: 同一话题连续追问只注一次是**设计行为**; 想验证就换话题再问。
4. **检索没召回**: 触发对了但结果空 → 走 `memory_search` 手动查同一个词; 若也空,
   看检索评测 `scripts/eval-retrieval.ts` (语义召回) 与索引状态 (`pnpm run verify` 里的 ftsStatus)。
5. **设置不生效 (必须重启才变)**: 检查该设置是否在插件**构造时**被读了一次。
   正确做法走 provider/函数 (例如 `episodes: () => store`、`autoEvolve: () => settings().x`)。
   回归证据: `tests/s2/settings-live.test.ts`。

## 调整旋钮

- 意图库: `DEFAULT_INTENTS` (`src/trigger/policy.ts`) —— 扩句式, 不要堆知识词;
- 漂移阈值: `TriggerPolicy({ driftThreshold })` (默认 0.8, 由同话题 ≤0.73 / 换话题 =1.0 标定);
- 预算: `alwaysOnBudget` (400) / `intentBudget` (300);
- 预热时限: 设置项 `semanticWarmupMs` (默认 50ms, 0 = 不预热);
- always-on 内容范围: `selectAlwaysOn` (规则 + 事实/偏好/决策; **不含** lesson —— lesson 走意图召回)。
