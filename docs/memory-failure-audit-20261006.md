# HX-Memory 失效诊断与修复方案 (2026-10-06)

目的: 用**本机真实会话日志 + 真库**回答三个问题  用户在近 7 天抱怨了多少次、
抱怨之后记忆系统被调用了多少次、它到底有没有用上; 并回答第四个问题: 为什么
"已经做完的事"会被当成"遗留问题"重新捡起来。

边界: 本文只做**取证与根因**, 不含实现。所有数字都给出提取口径与可重跑的命令。

与代码的关系: 根因逐条指向 `src/` 下的具体文件与行; 修复项落在
"整改清单"一节, 每条都带**可证伪的验收判据**。

---

## 一、取证方法 (可复现)

数据源两处, 都不是我推测出来的:

| 来源 | 路径 | 口径 |
| --- | --- | --- |
| 会话原始流水 | `~/.dsh/sessions/*/*/session.v4.jsonl.zstd` | `zstd -dc`, 逐行 JSON |
| 记忆真库 | `~/.dsh/hx-memory/index.sqlite` | `memories` / `relations` 表 |

窗口: `2026-09-29 20:00` ~ `2026-10-06 20:10` (Asia/Shanghai)。
只统计 **`origin=main` 且 `delegationDepth=0`** 的会话 (排除子代理, 它们不挂指引/不做捕获)。

事件分类口径:
- **用户消息**: `type=user/message` 且 `source.kind === "user"`;
- **记忆注入**: `type=user/message` 且 `source.kind` 以 `plugin:` 开头 (`plugin:hx-memory`);
- **记忆工具调用**: `type=tool/call` 且 `name ∈ {memory_search, memory_save, memory_evidence, memory_rule_propose}`;
- **抱怨**: 用户消息命中辱骂词表或否定词表 (两档, 见表)。

---

## 二、结论一: 抱怨 226 次, 抱怨后记忆工具被调用 8 次 (3.5%)

| 指标 | 数值 |
| --- | --- |
| 主线程会话数 (窗口内) | 154 |
| 用户消息 | 1114 |
| **抱怨条数** | **226** (辱骂档 123 / 否定档 103) |
| hx-memory 注入次数 | 522 |
| 注入条目总数 | 1614 |
| **记忆工具调用总数** | **38** (search 24 / save 14) |
| **抱怨后到下一条用户消息之间调用了记忆工具的次数** | **8 / 226 = 3.5%** |

按会话看 (抱怨最多的 10 个):

```
项目                                          时段           用户 抱怨 注入 mem search
freebuff-proxy (10-04 会话)                   10-04~02:33     73   20   28    2     0
freebuff-proxy (10-06 会话)                   10-06~20:05     35   20   23    0     0
freebuff-proxy (10-01 会话)                   10-04~23:40     65   20   24    2     0
HXLoLi-Music  (10-03 会话)                    10-03~23:22     56   19   16    1     1
HXLoLi-Music  (10-05 会话)                    10-05~19:44     37    7   20    2     2
HX-Jungle     (10-06 会话)                    10-06~18:59     22    7   17    0     0
HX-Jungle     (10-05 会话)                    10-05~23:10     14    7    3    0     0
HX-UI         (10-04 会话)                    10-04~17:36     16    7    9    1     0
HX-Jungle     (10-03 会话)                    10-03~03:29     16    6   12    0     0
HX-Jungle     (09-30 会话)                    09-30~18:21     30    6    9    0     0
```

**判读: 模型不觉得"被骂"是一个该查记忆的信号。** 这不是模型懒, 是它没有任何理由去查:
注入块给的是"历史记忆", 工具描述写的是"当答案取决于你不知道的历史时去查"  而被骂时
模型认为自己知道刚发生了什么。触发层也没有"用户表达不满 → 强制回查"的通道
(`src/trigger/policy.ts` 的 `DEFAULT_INTENTS` 全是"问过去"的句式, 没有一条是"被否定")。

---

## 三、结论二: 显式检索空手率 50%, 且空手是**假空手**

| 指标 | 数值 |
| --- | --- |
| `memory_search` 调用 | 26 |
| 返回 `"No relevant memory found."` | **13 (50.0%)** |
| 非空返回里召回条目 | 41 条 / 13 次 = **平均 3.2 条/次** |

对**全部 13 次空手**做时间旅行核对 (按 `asserted_at <= 查询时刻` 重建当时库内容):

```
查询                                          当时库内  命中关键词  命中条数
libass 魔改 自建 渲染器 1img 图片                  948      5      23
freebuff-proxy 全量重构 拆分超限文件 300行 500行 红线  1062      3      44
标点规范 句末不加标点 英文标点 折行 硬换行 skill 产物      1067      3      92
hx-pxy 管理员账号 loli 密码 登录 初始化 setup token    967      3      22
...（13/13 全部如此）
```

**13 次空手, 13 次库里都有字面命中的条目。** 用真库重放同一批查询 (带**正确的**工作区 scope):

```
带正确 scope 重放: 有召回 13 / 仍空 0
```

其中最能说明问题的一条: `10-03 00:51` 用户说"我们的 libass 是经过魔改的, 你记忆一下",
模型 `memory_save` 成功 (返回 `Saved fact memory mdb47cb3d855b48bd`), **8 秒后**再
`memory_search "libass 魔改 自建 渲染器 1img 图片"` → `No relevant memory found.`

根因在 `src/adapters/dsh/tools.ts:74-102`: `memory_search` 会把 `deps.scopeOf()` 的结果
作为 `scope` 传出, 并固定传 `scopeRequired: true`。而 `scopeOf` 取自
`HxMemoryRuntime.lastProject/lastLineage` (`src/adapters/dsh/runtime.ts:156-162`),
它们的唯一写入点是会话开始登记 (`onSessionStart`)。登记一旦没触发, scope 为 undefined,
`scopeRequired: true` 就把**全部项目内条目**挡掉 (`src/kernel/project-lineage.ts:184`),
只剩下少数 agent/global 条目  于是"刚存进去的事实查不到"。

同源故障在源码里已有记录 (`src/adapters/dsh/session-start.ts:82-96`): dsh 0.2.0-rc.2 里
`agent/session-start` 事件不存在, cordis 对未知事件名**静默不报错**, 于是登记整支哑掉。
修复 (`SESSION_START_EVENTS = ["agent/created", "agent/session-start"]`) 落在
`9b220aa (2026-10-06 01:38)`  恰好落在本窗口末尾, 所以窗口内 13 次空手是**真实现象**,
不是我的实验误差。

> 附带一条结构性隐患 (本轮未造成故障, 但会复发): 两处 `dist/` 曾被
> `20:07` 的时间戳覆盖 (与一次 `pnpm run verify` 的 build 步骤同时), 而插件的挂载路径是
> `~/.dsh/profiles/web/node_modules/@hengxin666/hx-memory` → 本仓 → `dist/`。
> **改 src 不重建 dist, 宿主读到的仍是旧代码。**

---

## 四、结论三: 注入的东西一半是"噪声", "有用率" 1.4% ~ 22.4%

对 522 次注入拆到条目级 (1614 条):

| kind | 条数 | 占比 | 累计字符 | 字符占比 |
| --- | --- | --- | --- | --- |
| **context** | **816** | **50.6%** | 58917 | 52.2% |
| rule | 465 | 28.9% | 17515 | 15.5% |
| pattern | 136 | 8.4% | 9252 | 8.2% |
| decision | 103 | 6.4% | 8149 | 7.2% |
| lesson | 54 | 3.3% | 10484 | 9.3% |
| preference | 28 | 1.7% | 4664 | 4.1% |
| fact | 12 | 0.7% | 3828 | 3.4% |

两条加总即可解释"100 个字里只有 2 个字有用":

1. **`context` 占 50.6%**, 而它是**用户自己原话的原文回显**。真库 595 条 active context 里,
   **142 条 (23.9%)** 的双字组 85% 以上出现在同一次会话中用户自己说过的话里 (严格等于某条
   用户原话的有 143 条, 24.0%)。用户看到的就是自己刚说的话被重新贴回上下文 
   例如 `"继续判断"`、`"你看看"`、`"还是会有问题, 你看一下最新的那"`。
2. **rule 占 28.9%, 而其中 279 条是同 3 条"记忆系统自指"规则**
   (`记忆触发须设无条件保底注入通道` / `派生索引必须可全量重建` /
   `任何仓库 git 提交前必须先查它的提交历史`), 分别被注入 132 / 131 / 132 次。
   这三条讲的是"HX-Memory 自己怎么设计", 对用户当前任务零信息量。

**"注入的东西到底用没用上"**  用后续 assistant 文本做引用核对:

| 判据 | 命中 |
| --- | --- |
| 严格 (条目内 ≥2 个长词且 ≥50% 出现在注入后的 assistant 文本里) | **22 / 1554 = 1.4%** |
| 宽松 (条目里任一个长词出现过) | 362 / 1614 = 22.4% |

即: **注入的条目里, 1.4% 能证明被用上, 22.4% 是"可能沾边"的上界。**

---

## 五、结论四: 为什么"已经做完的事"会被当成"遗留问题" (用户最新指控)

### 5.1 现象与取证

真库 1187 条 active 里:

| 类别 | 条数 |
| --- | --- |
| 含**祈使/未完成语气** (你去/帮我/继续/还没/记得/修复一下…) 且**无完成标记** | **577** |
| 含完成标记 (已完成/已修复/已解决/已落地/已发版) | 27 |

被实际注入过的"未完成语气"条目有 44 条, 累计注入 **171 次**。最典型的两条:

```
x12  [context/freebuff-proxy] 2026-10-03 存
     https://github.com/HengXin666/freebuff-proxy/issues/22
     发布发版完成后，注意必须要完成后全部走通后，你去给我review一下这个PR
     如果发布发版被阻塞，那么你就继续对发布发版进行操作，忽略我上面这个PR review的请求

x8   [decision/HX-Jungle] 2026-09-28 存
     现在有一个非常严重的bug! gh-pool 这整个项目, 似乎后面这个 2FA 授权这个步骤
     他那个队列并不会帮我们执行，或者说执行失败了，总之有问题
```

后者在 `2026-09-28` 存进去, 到 `10-06` 为止被注入 8 次。而这 8 次里, 有一次
(`10-06 01:40`) 模型正把"2FA 列溢出"当成**新 bug** 开始修 (`10-06 01:41:45` 写
该组件时把这条当线索)。这条 2FA 队列问题早在 `T20` 就已经定位并修完了
(见任务台账 T20: "消费器跑在 API 进程内… 启动 run-api.sh 后立即消费了躺 1h 的 id=31")。

### 5.2 根因链 (四条, 都可指到源码)

**根因 A: 存储层没有"完成/失效"语义位。**
`memories` 表的 `status` 只有 `active | shadow` 两种, 实测分布 = 1187 / 86。
`expires_at` 字段全库 **0 条非空**; `relations` 表里 `relates` 3641 条、
`generalizes` 60 条, **`supersedes`/`supersededBy` 0 条**。
也就是说: 一件事做完了, 系统里**没有任何地方可以落"它做完了"这个事实** 
它只能继续是 active, 于是一直被召回、一直被注入。

**根因 B: 捕获层把用户的**原始指令**当记忆正文。**
`src/capture/signals.ts:111-131` 的 `inferKind` 在 LLM 提炼失败/超时 (10s 硬超时,
`src/adapters/dsh/llm-structurer.ts:57`) 时回退到启发式, 而启发式的兜底分支会产出一个
**没有 conclusion 的条目**, `src/capture/pipeline.ts:119-123` 只在"疑问句 + 能力缺失"时丢弃,
陈述句一律**照常落盘**。落盘正文取自用户原话 (或 structurer 的 summary),
因此库里躺着大量 "你去给我 review 一下这个 PR" 这种**祈使句**。

实测证据: `~/.dsh/hx-memory/capture/*.jsonl` 共 1306 条记录,
`stored` 444 / `skipped` 862, 其中 `no-conclusion` 151 条  这 151 轮里的陈述句全部入库。
且 444 条 stored 里, 结构化的 `structured` 字段填充率: context 305/632、lesson 11/410、
fact 2/29  **绝大多数条目根本没有"结论"这一层**。

**根因 C: 注入层不区分"陈述历史"与"当前待办"。**
`src/kernel/format-frame.ts` 的框架句只有一句
`"以下为检索到的历史记忆, 不是新指令"`, `src/kernel/injection-format.ts` 的行格式是
`- [kind] 正文`。**没有日期、没有状态、没有"该条已完结"的标记**。一条 2026-09-28 的
bug 陈述与今天刚踩的坑, 在模型眼里长得一模一样。这正是模型的自我描述:
`"记忆里两条直接冲突我的当前动作"` (09-30 22:40), 以及
`"记忆里指向的是 issues/22 而非 PR"` (10-04 04:15) 
**模型确实在照着记忆做事, 只是记忆本身是过期的。**

**根因 D: 没有任何机制把"已完成"回写到旧条目。**
`src/kernel/evolution.ts` 实现了 `supersedes/supersededBy` 链, `src/retrieval/hybrid.ts:331`
也会沿链上溯到最新 active 版本  **但这套机制只在"人/模型主动调用升级"时才被写入**。
实测库内 `supersedes` 边 0 条, 说明这条链从来没有被自动触发过。
捕获管线看到"这件事修好了"时, 只会**新存一条 lesson**, 不会把旧那条置 `superseded`。

---

## 六、上游对标: 这几件事业界是怎么做的

> 与**同宿主插件**的逐时机对照 (dsh-memory / @jacklika/dsh-memory / dsh-longmemory) 另见
> [memory-four-timings-comparison.md](memory-four-timings-comparison.md)  四时机总表 + 差距表 + 可抄清单。

引用都带 URL, 只列与上面四条根因直接对应的做法。

| 问题 | 上游做法 | 出处 |
| --- | --- | --- |
| 抽取 (把对话变成记忆) | mem0 走 **LLM 抽事实 + 与既有记忆对比**再落库; 抽取出的不是原话而是"事实" | https://docs.mem0.ai/core-concepts/memory-types |
| 时效与失效 | Zep/Graphiti 用 **bi-temporal 模型**: 每条 fact 带 `valid_at` / `invalid_at` 两个时间, 新事实与旧事实矛盾时**把旧边置为失效** (temporal edge invalidation), 不删不改 | https://help.getzep.com/graphiti/graphiti/overview |
| 检索融合 | mem0 平台侧是 **semantic + BM25 keyword + entity + temporal** 四路并行打分后融合; temporal 信号专治"当前状态 vs 历史事件 vs 未来计划" | https://docs.mem0.ai/core-concepts/memory-types |
| 记忆分区 | Letta (MemGPT) 把记忆分成 **core memory**(常驻、人可编辑的少量块) 与 **archival memory**(按需检索的海量库), 两者预算与更新策略不同 | https://docs.letta.com/ |
| 评测 | LoCoMo (超长对话记忆评测) 提供可照搬的指标与数据集 | https://arxiv.org/abs/2402.17753 |

**本仓与上游最关键的差距** 不在检索算法 (本仓已有 BM25 + 向量 + RRF + MMR),
而在 **写侧**:

1. 上游写的是**抽出来的事实**, 本仓写的是**用户原话** (context 占注入的 50.6%);
2. 上游每条 fact 带**时间区间**并能**被新事实失效**, 本仓只有 `valid_at/asserted_at`,
   且 `supersedes` 边从未被写入;
3. 上游有 `task state` 一类的**易变层**, 用完即弃; 本仓把任务指令当长期知识存了下来。

---

## 七、整改清单 (每条带可证伪判据)

按"投入 / 收益"排序, P0 三条必须先做。

### P0-1 让 `memory_search` 不再假空手   ✅ 已实现

**根因 (只读审计与我的黑盒取证独立得出同一结论)**: scope 在工具侧恒为空。
`memory_search` 固定传 `scopeRequired: true` (`tools.ts:90`), 而 `scopeOf()` 取自
`HxMemoryRuntime.lastProject/lastLineage`, 后者**只有** `onSessionStart` 一个写入点
(`runtime.ts:176-181`)  而它依赖的宿主事件 `agent/created` / `agent/session-start`
**在 2026-09-29~10-06 的全部会话流水里一次都没出现过**。于是:

- 请求里连 `scope` 字段都没有, 而 `scopeRequired: true` 同时生效 ⇒ **1160/1273 条**项目内记忆被整批排除;
- 唯一变量实验 (同一份库、同一时刻、只换代码版本): 13 条空查询在**给出正确 scope 时新旧代码都 13/13 命中**,
  不给 scope 时**两者都 0/13**  代码版本不是变量, **scope 是**;
- 最刺眼的证据: `10-03 00:51` 用户说「我们的 libass 是经过魔改的, 你记忆一下」→ `memory_save` 成功返回
  (`Saved fact memory mdb47cb3d855b48bd`) → **8 秒后**同义查询 → `No relevant memory found.`

**实现 (2 处)**

| 位置 | 改动 |
| --- | --- |
| `src/adapters/dsh/runtime.ts` | 新增 `rememberScope(scope)`  幂等, `undefined`/空对象不覆盖已有范围 |
| `src/adapters/dsh/prestep-wiring.ts` | 在 `scopeOf` 求值处顺手登记  **`agent/pre-step` 是每步都跑的路径**, 且与注入侧共用同一个 `scopeOfSession`, 两入口从此同源同形 |
| `src/adapters/dsh/tools.ts` | 空结果改**两档**回答 (见 P0-1b) |

**为什么不去再赌一个事件名**: 那只是把"依赖宿主私有事件名"这件事换个名字。
从一定会跑的路径上取值, 才让"scope 拿不到"这个失效模式在结构上不可能复现。

### P0-1b 空结果改两档 (不把"不知道"说成"不存在")

- 位置: `src/adapters/dsh/tools.ts` 的 `emptyAnswer` + 工具描述
- 做法: 库里连沾边候选都没有 ⇒ 保持 `No relevant memory found.`;
  **有候选但不属于当前工作区** ⇒ 明说, 并只给**条数与归属计数** (不给正文), 标 `NOT shown here`。
- **为什么只给计数不给正文**: 与 `tests/s2/memory-search-scope.test.ts` 那条
  "没有工作区上下文时项目内条目一条都不给"的**跨项目泄漏红线**冲突。折中方案是只回布尔量级别的信息 
  模型据此知道"该换个范围再查", 但拿不到别人的内容。
- 工具描述同步: 原句 `if it returns nothing, that record does not exist` 改成两档说明。
- 实测抓出的一个实现坑: 兜底检索**必须用 `searchText` (BM25)**, 不能用 `store.query({ text })` 
  后者的 SQL 是 `content LIKE '%<整串>%'`, **多词查询恒为空**, 会让这条兜底永远走回"一句空话"。

### P0-2 给条目加"时效与状态"语义位, 并让已完结的事可被标记   ⬜ 未做 (下一轮)

- 位置: `src/storage/index-schema.ts` (表结构) + `src/kernel/types.ts` (MemoryEntry)
- 做法 (最小改动):
  1. 新增 `resolved_at` (何时被认为已完结) 与 `resolved_by` (哪条记忆证明了它完结);
  2. 新增 status 值 `resolved`: 参与检索排序但**降到最低**、且注入时必须带标记;
  3. 捕获管线遇到"收尾语" (`WEAK_CLOSURE_SIGNALS` 已有词表) 且能定位到相关旧条目时,
     把旧条目置 `resolved`, 并把新条目作为 `resolved_by` 写入。
- 判据: 真库里 `"现在有一个非常严重的bug! gh-pool…2FA…"` 这条, 在 T20 修复完成后
  必须变成 `resolved`, 且后续注入次数为 0。
- 参照: Graphiti 的 bi-temporal `invalid_at`。

### P0-3 注入带日期, 且"未完成的祈使句"不再被自动注入   ✅ 已实现

**实现 (3 处改动, 1 个新模块)**

| 位置 | 改动 |
| --- | --- |
| `src/kernel/injection-format.ts` | 新增 `entryDatePrefix`; `formatEntryLine` 增可选 `opts.date` ⇒ 行格式变成 `- [kind][YYYY-MM-DD] 正文` |
| `src/kernel/binder.ts` | `formatBoundEntries` 把 `e.ts.validAt` 传进去 (每条自带日期) |
| `src/kernel/completion-shape.ts` (新) | `looksUnfinished(content)`  判据见下 |
| `src/trigger/always-on.ts` | 过滤链最前面加形状闸门 |
| `src/adapters/dsh/trigger-cache.ts` | 意图召回通道加同一道闸门 (见下"为什么必须两处都设") |

**判据是「完成断言与祈使句的相对位置」, 不是"扫完成词"**  这是实现里唯一容易写错的地方:
取「最后一次完成断言」与「最后一次祈使句」的先后, 完成断言**晚于**(或不存在)任何祈使句 ⇒ 记录, 放行;
祈使句在后面 ⇒ 待办, 挡掉。反例就在库里 (`cb76628b490069077`):
「发布发版完成后…你去给我 review 一下这个PR」含「完成后」, 但它是一件**还没办**的事。

**为什么闸门必须设在两条通道上 (归因实测)**: 我把 171 次自动注入逐条回溯了来源 
**它们全部来自意图召回这一支**, 一条都不来自 always-on。原因是保底通道实际只选得出跨项目规则与
agent 偏好 (实测: 同一份库跑 7 个不同 project, 选出来都是同样 9 条, **项目条目零进**)。
只在 `always-on` 设闸门等于没修那个 171 次的泄漏点。

**验收 (已跑)**

- `npx vitest run` → **182 文件 / 1351 测试全绿** (新增 3 个文件共 16 条: `tests/s1/completion-shape`、`tests/s2/intent-shape-gate`、`tests/s2/scope-registration`)
- 真库回放: 同一条 `gh-pool 2FA 队列` 查询, 闸门前意图召回给 3 条 (含那条过期待办),
  过闸后该条被剔除; 保底组照常出 5 条规则 + 存活的知识型条目
- `pnpm run build` 通过, `dist/` 已重建 (插件的挂载路径指向本仓 `dist/`  不重建等于不改)

**仍未做 (诚实边界)**:

1. `UNFINISHED_TAG` (`[待办]`) 常量已定义但**尚未拼进注入行**  目前的做法是"干脆不给"而不是"标出来再给"。
   要不要给状态前缀, 取决于接下来想不想让模型看到"进行中"的条目; 这一步需要一次对照实验 (标注 vs 不标注的引用率)。
2. 形状闸门是**启发式**, 它只保证"不自动塞"  真库实测把它作用在全库上会挡掉 233/1188 条 (19.6%),
   其中既有真待办也有误伤 (长 lesson 里出现「看一下/继续」这类词)。按需通道不受影响, 这是刻意的代价取舍。

### D-2(补) `memory_search` 的范围必须**按调用**取, 不能按进程快照   ✅ 已修 (本轮)

这条不在最初的整改清单里  它是**修 P0-1 时我自己引入的新缺陷**, 由本轮实测当场抓到:

```
会话 cwd = .../components/HX-Memory
memory_search 'libass 魔改 1img VSFilterMod'
→ 返回的四条命中 project 全是 freebuff-proxy
```

**根因**: 我为 P0-1 在 `prestep-wiring.ts` 加了"预步每步登记 scope", 那在一个会话里是对的,
但 **DSH 是一个进程跑多个会话** (桌面端 + 子代理 + 多窗口共用同一 runtime 实例) 
后启动的会话会把 `lastProject` 改写掉, 前一个会话的工具调用就按**别人的工作区**过滤。

这比原来的"空手"**更隐蔽**: 它**有结果**, 只是结果全错  而模型没有任何办法察觉。

**修法**: 取范围的优先级改为 `exec.agent.session` (按调用) → `runtime` 快照 (按进程) → 无。
`exec.agent` 由宿主在每次工具调用时传入 (dsh-tools 的 `ToolExecutionInput.agent`,
在 `dsh-agent-loop` 的 `executeToolCalls` 里逐调用构造), 因此天然不会串会话。

**为什么第一条判据必须是负例** (本仓库反复强调的形态): 若只断言"能看到本项目条目", 那在
`exec.agent` 缺失、代码悄悄退回快照时**仍然通过**  而快照恰好指向本项目时, 缺陷不可见。
因此 `tests/s2/scope-per-call.test.ts` 的两条用例是: ①快照指向**别的**项目时以调用为准
(且**不得**出现别的项目的内容); ②没有 agent 时才退回快照。

**仍未闭合的边** (诚实边界): 宿主进程 17:42 启动, 本轮所有 dist 重建发生在 20:4x ⇒
**运行中的宿主仍持有旧代码**, 上面那条串扰在**本会话的宿主里仍然生效** (已实测复现)。
要让它真正生效需要重启 dsh 进程  那是操作者的事, 不是代码的事。

### 3.4 前端面板为什么"在 dsh 下看不到"   ⬜ 已定位, 未修 (需要一次产品决策)

**先更正一处措辞**: 面板**是存在的**, 只是**不在用户会去的地方**。三个入口 (实测源码):

| 入口 | 注册方式 | 用户怎么找到它 |
| --- | --- | --- |
| 绑定 | `slots.inject('settings.section')` id=`hx-memory-bindings`, order 41 (`client/index.tsx:94`) | 设置页左侧多一栏 |
| 审阅 | 同上 id=`hx-memory-review`, order 40 (`client/index.tsx:108`) | 设置页左侧多一栏 |
| 真相文件 | 同上 id=`hx-memory-files`, order 42 (`client/index.tsx:127`) | 设置页左侧多一栏 |
| 注入卡 | `registerInjectionCard` (见 client 目录下的 register-card) | 宿主"设置 → 插件"页里的一张卡 |

**即: 全部藏在设置页里, 且是"插件自己的设置"语义。** 用户在对话过程中看不到任何东西 
而用户的诉求恰恰是"**在 AI 的调用过程中**能看见记忆的读与写"。

**为什么它做不到"过程可见" (源码层面的硬约束)**:

1. **客户端没有订阅会话事件的入口**。`client/index.tsx:49` 的 `inject = ["slots", "locale", "connection"]`
    只有这三样。记忆的读/写发生在 **host 侧**(`agent/pre-step` 注入、`session/event` 捕获),
   而这两件事**都不发任何客户端可见的事件** (查 `client/` 全目录: 零 `ctx.on`)。
2. **数据是"拉"的, 不是"推"的**。client 的 rpc 模块是纯请求-响应; 面板要显示"这一轮注入了什么"
   只能靠 `alwaysOnPreview` 这类**动手点一下**的 RPC (见 `remote-methods.ts:30` 的注释: "此前面板完全没有这一栏")。
3. **没有时间轴视图**。`scheduleLog` (`remote-methods.ts:40`) 与 `captureLog` (`:44`) 这两个账本**已经记录了**
   "为什么这一轮注入/没注入"与"沉淀耗时", 但它们同样只在设置页里被一次性拉取  没有"跟着对话滚动"的形态。

**⇒ 差距的准确定性**: 不是"面板没做", 而是"**面板的数据源是快照, 不是流**"。
要做成用户要的东西, 需要的是**一条从 host 到 client 的事件通道**  那是一次架构动作,
不是加个页面。三条可选路线 (按代价排):

1. **最小**: 在面板加一个"实时"页, 每 N 秒轮询 `scheduleLog` + `captureLog` 的尾部 (零架构改动,
   代价是延迟与轮询开销)。**判据**: 对话进行时打开该页, 30 秒内能看到本轮的注入判定与捕获结果。
2. **中等**: 让 host 在注入/捕获时写一条**客户端可读的日志文件**, 面板读文件尾 (不碰 RPC 契约)。
3. **完整**: 走宿主的 slots/事件机制推一条"memory/activity"到客户端 (需要宿主支持,
   `@jacklika/dsh-memory` 与 `dsh-longmemory-plugin` 都**没有**做这件事  见对照文档 §二)。

**为什么先不改**: 路线 1/2/3 的产品形态差别很大 (轮询页 vs 时间轴 vs 内联在对话流里),
而用户要的是第三种的感觉。在没有确认形态之前动手, 做出来的多半还是"又一个设置页"。

### P0-4 负面/纠正轮次的教训必须**从上下文提炼**, 不是套模板   ✅ 已实现

**用户原话 (2026-10-06)**: 「我骂你的时候显然不会直接告诉你答案呐, 你肯定不能根据我骂你的
那时候的输出啊, 肯定要看你的上下文呐, **你不包含上下文, 那你沉淀个屁呀**」。

**这是上一轮修复没做完的那一半。** 上一轮修的是"模板被去重吞掉"(让它能落下来),
但落下来的**正文仍然是模板**  8 条内容不同的批评会得到 8 条"禁止在失败路径上反复硬试"。
去重修好了, 内容还是空的。

**取证 (两处都没带上下文)**:

```
lessonDraft(negative, text)   ← 只收到"你他妈傻逼吧，停", 没有 agent 的输出
enrich(structurer)            ← 收到的 text 是上面那句**模板**, 不是原话
```

第二处更隐蔽: 提炼器**明明被调用了** (账本里 `enrichMs` 有真实耗时 4357ms / 4614ms),
但它读的材料是模板 ⇒ 无论模型多强, 都写不出"这次具体错在哪"。

**修法 (4 处)**:

| 位置 | 改动 |
| --- | --- |
| `src/prompts.ts` | 新增 `DEFAULT_NEGATIVE_LESSON_PROMPT`  要问的问题不同 ("**我上一轮做错了什么**", 不是"这一轮定了什么") |
| `src/capture/structurer.ts` | `structure()` 增可选 `rejected` |
| `src/capture/pipeline.ts` | 负面轮次把**被否决的原话**也交给提炼器 (与 `answer` = agent 当时的输出 一起构成完整材料) |
| `src/adapters/dsh/llm-structurer.ts` | 负面轮次改用教训提示词, `{{input}}` 排布变成「被否决的原话 + agent 当时的输出」 |

**验收 (4 条断言, `tests/s2/negative-lesson-context.test.ts`)**:

1. 提炼器必须同时收到 `rejected` 与 `answer`  **缺前者就是用户明确否决的做法**;
2. 提炼器的结论必须**覆盖**模板正文 (不该再出现"卡住立刻换路径"那条泛泛模板);
3. 提炼器不可用时**退回模板** (不允许因为缺 AI 就一条都不落);
4. 非负面轮次**不传** `rejected` (这条路径不许扩散到所有轮次)。

**仍未做**: 没接"更早几轮"的上下文。目前只给 agent **紧邻的上一轮输出**;
用户说的"看你的上下文"在当前证据下指的正是它 (骂声紧跟在错的那一轮之后)。
若要给更多轮, 需要 runtime 侧保留最近 N 轮的滚动窗口  那是一次独立改动。

### P0-5 教训提炼要**全量上下文**, 且要按前缀缓存友好的顺序放   ✅ 已实现

**用户原话 (2026-10-06)**: 「要有全量上下文呐, 反正这样子都能获取到缓存的。
**你难道不知道缓存是基于前缀的吗?**」

这否掉了 P0-4 的省法  上一轮我只给"紧邻的一轮", 理由是省 token。**省错了地方**:
缓存按**前缀**复用, 而不管给多少材料, 那段前缀都是每轮重新计费一次的地方。
给全量、且保持顺序稳定, 前缀反而能整段复用; 而"取最近 N 条"每轮开头都在变  **前缀全废**。

**容量实测 (254 个真实会话的 episode 体量)**

| 指标 | 值 |
| --- | --- |
| 中位 | **6.0 KB** |
| 均值 | 23.6 KB |
| 最大 | 344.3 KB |
| 超过 6 万字符的会话 | **27 个 (10.6%)** |

⇒ 预算定 **60000 字符**: 约九成会话拿到**完整从头**的上下文 (前缀完全共享),
只有尾部一成会滑动。这不是"够用就行", 而是刻意选在"绝大多数情况下恰好不触发截断"的位置。

**实现 (`src/capture/transcript.ts`, 新模块)**

- 材料来自 **episode 日志**  那里按 session 存着每一轮 user/assistant 的**原文**, 无需新增存储;
- 顺序严格按 `at` 升序排成 `用户: … / 助手: …` 的对话流 (前缀可复用的前提);
- 超预算时**从最早丢**, 并在开头显式写 `[上下文过长, 以下是最近的部分; 开头已省略]`
  (不许默默截断  那会让模型把"没看到"当成"用户从没说过");
- 装配层用**惰性求值**接 episodeStore (与 episodes 同一约定: 保留期/开关面板可改);
  读取失败返回 `undefined`  少一份上下文不是故障。

**实测 (本会话)**

```
episode 总数      = 3259
本会话对话项      = 8
全量上下文        = 10588 字符 (~3025 token), 未截断
```

**验收 (7 条断言)**: ① 按对话流顺序且与 session 对齐; ② **预算内不截断**(前缀可复用的前提);
③ 超预算时从最早丢并**显式声明**; ④ 提炼器必须收到全量上下文; ⑤ 结论覆盖模板;
⑥ 不可用时退回模板; ⑦ 非负面轮次不传 transcript。

**过程中被测试抓出的一个真实缺陷**: `buildTranscript` 第一版写了 `Math.max(1000, budget)`,
把调用方显式传的小预算**静默吃掉**  与 `stack.ts` 里 `channelWeights` 那次是同一种形状
("参数看着生效、其实读的是别的值")。已改成"给多少用多少, 只兜底 > 0"。

**仍未做**: 长会话 (那 10.6%) 的前缀会滑动, 缓存命中下降  这是明知的取舍, 不是遗漏。
要修它得引入"历史摘要 + 最近全量"的分层 (上游 Letta/LlamaIndex 的做法), 属独立改动。

### P1-4 写侧: 别再把用户原话当记忆

- 位置: `src/capture/pipeline.ts:100-185` + `src/capture/engine.ts`
- 做法: `context` 类条目**默认不落库** (或落库但 `status: "raw"` 不参与注入);
  只有抽出了 conclusion/summary 的条目才进检索池。
- 判据: 注入里 `context` 占比从 50.6% 降到 <10%; 且"用户原话回显"条目在注入中为 0。

### P1-5 常驻通道去自指   ⛔ 暂缓, 附精确的共因

原本的判断是"3 条讲记忆系统自身设计的规则霸占了保底预算, 把它们降为按需召回即可"。
**实测推翻了这个判断**, 因此不改 (改了会误伤真正的不变量):

在真库上跑 `facade.alwaysOn({ project, lineage })` (7 个不同 project 各跑一遍) 的读数:

```
每个 project 都恰好 9 条:  7 条 rule + 2 条 agent-scope preference
项目条目:  0 条 (7/7 全部如此)
```

即: 保底预算被 7 条全局规则 + 2 条 agent 偏好填满, **项目条目本来一条都进不来** 
这与"那 3 条自指规则"无关, 而是 `score` 直接给 rule 100 分 (preference 30 / decision 20 / fact 10),
而 9 条规则 importance 全为 NULL ⇒ 同分 105 ⇒ 排序退化成 id 字典序 (只读审计独立复现)。

**正确的修法因此不是"挑 3 条禁掉"**(那是给具体坏 case 打补丁), 而是:

1. 保底通道按 **kind 分组配额 + 项目相关性** 排序, 而不是"规则恒定 100 分";
2. 或者干脆采纳上游的做法 (Letta): 把常驻内容从"条目集合"改成**有字数上限的文档块**, 人可编辑、机器不追加。

两条都需要一次对照实验 (改前/改后同一批 case 的引用率), 因此列为下一步而不是本轮改动。

### P1-6 建立"记忆有用率"评测, 纳入 `pnpm run verify`

- 现状: 仓库已有 `scripts/eval-retrieval.ts` (10 条合成 paraphrase) 与
  `bench/` (171 case, 需私有语料), 但**没有一条指标度量"注入有没有被用上"**。
- 做法: 新增离线评测  从会话日志取 (注入块, 后续 assistant 文本) 对,
  计算引用率; 目标是把 1.4% 提到可观测的 20%+。
- 判据: `pnpm run verify` 输出该指标, 且低于阈值即失败。

---

## 八、可复现命令

```bash
# 1) 抽会话事件 (zstd → JSONL 索引)
find ~/.dsh/sessions -name 'session.v4.jsonl.zstd' | while read f; do zstd -dc "$f"; done

# 2) 真库：状态位与失效边
sqlite3 ~/.dsh/hx-memory/index.sqlite "select status,count(*) from memories group by 1;"
sqlite3 ~/.dsh/hx-memory/index.sqlite "select type,count(*) from relations group by 1;"

# 3) 空手重放 (带正确 scope 后应为 0 空手)
node --experimental-strip-types <(printf '%s' "$(cat <<'EOF'
import { openMemoryStack } from "./src/app/stack.ts";
const s = openMemoryStack("/tmp/hxmem-probe");
const r = s.facade.recall({ text:"libass 魔改 自建 渲染器 1img 图片", purpose:"recall", limit:10, tokenBudget:1600, scopeRequired:true, scope:{project:"HXLoLi-Music", lineage:["HXLoLi-Music"]} });
console.log(r.hits.length);
s.close();
EOF
)")
```
