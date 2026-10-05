# Agent Note: memory_search 跨项目泄露 (agent 侧检索缺省必须"不给")

Status: implemented

## Problem

`memory_search` 调用 `facade.recall()` 时**只传 text/limit/tokenBudget, 一个 scope 都没传** ——
它搜的是**全库**。实测 (真库 706 条, 同一句查询):

| 调用形状 | 返回 | 其中别的项目的条目 |
| --- | --- | --- |
| 不带 scope (生产实际) | 9 条 | **7 条** (HX-OutlookRegister / HX-Jungle / ds-test) |
| 带 scope | 3 条 | 0 |

后果不是"多召回几条", 而是**把别的项目的私有结论当成当前项目的经验**。
实测踩坑现场: 用户问"这个项目的目标是什么", 命中的是
`[context][project][HX-OutlookRegister] 总之目标就是成功协议化注册一个账号` ——
别的项目的目标条目, 被当成当前项目的答案; 用户当场指出"你为什么读到别的项目的东西去啊"。

**这是同一个缺陷形状在第二个入口的复现。** `adapters/dsh/trigger-cache.ts` 的 `recallFor`
此前也**完全不带 scope**, 当时的注释已写明"always-on 通道辛苦做的项目隔离, 被紧跟着的召回
原样漏掉"。那次只修了 `recallFor`, `memory_search` 这处**同形状的漏洞留了下来** ——
正是本仓反复强调的"两个入口口径分叉": 只修一处, 另一处**静默**泄漏 (没有报错, 只是答案来自别处)。

## Decision

**① agent 侧检索必须显式声明"我要项目范围"。**
新增 `RetrievalRequest.scopeRequired`; `memory_search` 两条路径 (facade / retriever) 都传它。
`runtime` 新增 `scope()` 访问器 (项目键 + 祖先链), 经 `MemoryToolDeps.scopeOf` 注入工具层 ——
形状与 `trigger-cache.recallFor` 的 `ranged` **完全一致**, 两入口同口径。

**② 判据收口到 kernel 的单一函数, 用参数表达两种缺省。**
`projectEntryVisible(project, scope, { required })`: 没有工作区上下文时,
`required: true` ⇒ **不可见** (agent 侧), 缺省 ⇒ 放行 (面板/CLI 管理面)。
这不是把判据写两遍, 而是**同一个判据的两种调用语义** —— 收口仍只有一处。

**③ 降级路径不能照抄参数名。**
`store.query({ project })` 的 SQL 是 `project = ?` (index-reader.ts:225) —— 一刀切,
会把 **`scope:"global"` 的跨项目规则一起砍掉** (规则行的 project 是空的)。
而主路径语义只过滤 project-scope 条目、保留 global。两者**同名的两种语义**,
因此降级路径改为取回候选后**在内存里按同一口径过滤**。

## Alternatives considered

**改 `projectEntryVisible` 的默认值为"拒绝"。** 否掉: 面板与 CLI 搜索**故意**不传 scope
(`gateway-memory.ts` 面板搜索、`codex/cli.ts` `search` 命令) —— 它们是管理面, 用户要看全库。
改默认值会同时打断它们 (实测确认这两个调用点都没有 scope)。两种缺省都要留着, 所以做成显式参数。

**给 `memory_search` 的 schema 加 project 参数让模型自己填。** 否掉:
工作区是**宿主已知的事实** (runtime 在 session start 就算出来了), 让模型猜/填是把它变成
一个概率判断 —— 与本仓"读记忆不靠模型自觉"的立项理由直接冲突。
模型漏填就等于回到泄露, 且**没有任何报错**。

**只修 `memory_search`, 不动降级路径。** 否掉: 降级路径 (`deps.store.query`) 是
"没有 facade 的老装配"走的, 同样是**全库**返回, 同一缺陷的第三个入口。

**把 scope 的默认值改成"继承上一次会话的 project"。** 否掉: 那是隐式状态,
多会话交替时会互相污染 (与本仓 `trigger-cache` 曾踩过的"缓存只有一份"同类)。

## Consequences

换来的: agent 侧检索不再看到别的项目的私有记忆; 跨项目规则与 agent 共享层仍正常可见;
父工程记忆经祖先链在子仓库可见 (嵌套仓库不割裂); 判据只有一处, 下次不会再在两个入口分叉。

付出的: `runtime` 多存一份 lineage (与 project 同一时刻算出, 不额外解析);
`MemoryToolDeps` 多一个可选访问器 (缺省退回旧行为, 兼容测试与无宿主场景);
降级路径多一次内存过滤 (候选取 `limit*3` 再截断)。

## Testing

`tests/s2/memory-search-scope.test.ts` (新增 4 项): 别的项目的私有决策**不得**出现;
没有工作区上下文时项目内条目**一条都不给** (不退化); `scopeRequired` **不误伤 global 规则**
(单独测, 防"修泄露时顺手把跨项目规则砍了"); 父工程记忆经祖先链可见。
全量: `npx vitest run tests/s1 tests/s2 tests/s3` → 172 文件 / 1214 测试通过。
真库复核: 同一句查询从"9 条含 7 条别的项目"变为"3 条全部属于本项目或共享层"。

## 清理副产物与本篇无关

同批对真实记忆库做了一次人工整理 (撤回 50 条噪声: 3 条崩溃日志/终端转储 + 5 条纯过程记录
+ 1 条外部工具配置 + 41 条单字回话)。那是**数据操作**, 不是代码改动 —— 走 `applyForget`
写 `status: shadow`, 真相原文保留、可 `revive`, `hx-memory verify` 报 751=751=751 ok。
详见下方"未解决"。

## Honest limits (未解决)

**超长条目没有可靠的精炼手段, 这次没动。** 实测: active 总字符 547k 里 **129 条超长条目
(≥1500 字符) 占 43%**, 而它们**全部没有 `structured.conclusion`** (0/129) ——
即全是启发式兜底存下的**原始转录**, 不是提炼过的记忆。而 `conclusion` 机制本就是为
"记忆层从转录升为提炼"设计的 (见 `capture/structurer.ts` 头注), 只是这些条目落盘时
没有可用的结构器。
⇒ 正解是**让结构器覆盖到这些条目** (或重放), 不是批量改写 `content` (那会破坏真相原文)。
本次不猜、不做, 记录在此。数据整理的范围与判据见提交信息。
