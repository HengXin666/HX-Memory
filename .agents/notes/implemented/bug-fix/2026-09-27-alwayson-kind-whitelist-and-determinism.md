# Agent Note: 保底通道的 kind 白名单被 lineage 绕过 + 排序缺确定性

Status: implemented

## Problem

三件事在真实记忆库 (702 条) 上被同时实测出来, 都发生在 always-on 保底通道
(`src/trigger/always-on.ts` 的 `selectAlwaysOn`), 且**都不会让任何测试变红**。

**① kind 白名单被 scope 判据短路 (主缺陷)。**
`scope === "project"` 分支原先写的是 `return lineageVisible(e.project, opts.lineage);` ——
**提前 return, 把后面的 kind 白名单整个绕过**。而"这条例子的 kind 是什么"与
"它在哪个项目"本是**正交的两件事**, 却被写成"scope 命中即放行"。

实测 (真实库, `lineage=["HX-Memory","HXLoLis"]`): 候选里混进
**lesson 348 条 + context 50 条 + pattern 8 条** —— 全是设计上"按需召回"、不该常驻的东西。

对照实验证明**唯一变量就是 lineage**: 同一批条目不传 lineage 时一个都不放行, 传了就被短路。
而生产路径 (`adapters/dsh/trigger-cache.ts:82`) **总是**传 lineage ⇒ 这是活缺陷。

**为什么没被发现**: 既有的 `不收 lesson` 断言 (`tests/s1/trigger-policy.test.ts`)
调用时**不传 lineage**, 走的正是没缺陷的那条分支。缺陷恰好在生产路径唯一走的分支上。

**② 平时被预算掩盖, 一放大就漏。**
400 token 的保底预算通常只装得下规则, 于是被短路的条目只是"排在候选里但进不来"。实测放大预算:

| 预算 | 注入条数 | 按 kind |
| --- | --- | --- |
| 400 | 9 | rule 7 / preference 1 / decision 1 |
| 2000 | 17 | rule 9 / preference 2 / decision 6 |
| 20000 | 92 | 含 **lesson 9 + context 47** + pattern 7 |

**③ 排序缺确定性 tiebreak ⇒ 两个入口选出不同集合。**
`scored.sort((a, b) => b.score - a.score)` 在分数相同时 (`同 kind + 同 importance` ——
规则几乎总是这种情况, 因为规则分都是 `100 + importance`) **继承输入顺序**。而两个入口给的顺序不同:

- `store.all()` → 真相文件里的块顺序;
- `store.entrySummaries()` → `SELECT ... WHERE status='active'` 的 SQL 行序 (**无 ORDER BY**, 不确定)。

实测同一 project/lineage/预算: 两条路径选出**不同集合** (`facade.alwaysOn` 8 条 vs
直调选择器 9 条, 集合差 4 条); 把输入数组**反转**后又选出另一组。
⇒ "同一份记忆、同一个工作区, 注入内容却取决于哪个投影被命中", 且**无任何报错**。

## Decision

**① 把 kind 判据抽成命名函数并前置。**
新增 `isAlwaysOnKind(kind)` (rule / fact / preference / decision; 显式排除 doc),
放在 filter **最前面**; scope 可见性判据移到其后, 两者变成**与**关系。
抽成命名函数而不是留一行枚举兜底, 是为了让"kind 判据与 scope 判据正交"这件事**结构上**成立,
而不是靠注释提醒下一个改动者。

**② 排序加 id 作最终 tiebreak。**
`b.score - a.score || (a.id < b.id ? -1 : ...)`。这是**确定性**诉求, 不是"id 小的更该注入" ——
它没有语义偏好, 只保证"同一逻辑查询 → 同一结果", 让差异只能来自语义字段而非数组次序。

**③ 注入行加行首 kind 标记。**
`formatEntryLine(id, content, kind?)` 产出 `- [rule] 内容 <!--hx-memory:id=…-->`。
理由: 注入块的框架句明写"**标记为规则(rule)**的条目是用户确认过的跨项目约束,
相关时应主动说明你在引用它" —— 而此前行里**没有任何 kind 标记**, 那句话指代不到任何对象。
实测症状: 8 条平铺在一起 (6 条 rule + 1 条 agent 偏好 + 1 条已被推翻的 project 决策),
模型侧没有任何线索区分它们的效力等级。

同时**收口三处手拼**: `app/format.ts` 原先自拼 `"[规则] "`, `recall/service.ts` 原先自拼
`"[" + e.kind + "] "` —— 不收口会与新标记叠成 `- [规则] [rule] …` 的双重标记。
kind 用 `entry.kind` **原值**(英文), 不建中文映射表 (多一张表就多一个静默漂移源)。

## Alternatives considered

**只在 scope 分支里补一句 kind 判断 (最小改动)。** 能修 ①, 但保留"白名单是 filter 末尾一行兜底"
的结构 —— 下一个人再往 project 分支里加 `return` 会重演同一个缺陷。
实测证据: 本缺陷之所以存在, 正是因为白名单当时就在末尾、而前面多了一个提前 return。

**把 `doc` 之外的所有 kind 的 scope 可见性统一处理 (合并两个分支)。** 否掉:
`agent` scope 只收 fact/preference (不含 decision), 而 `project` 收 decision ——
这条差异是**原有语义**, 合并会静默放宽 agent 层。两处判据不同, 就该写两处。

**收紧成"保底通道只 injection global 规则"。** 我在实现中试过 (把兜底写成 `return false`),
**当场打红** `tests/s2/kb-index.test.ts` 的对照用例 (同内容的 `global fact` 必须进、`global doc` 必须不进,
唯一变量只有 kind)。"收紧 kind" 与 "收紧 scope" 是两件事, 不能顺手合并 —— 已还原为保留原有行为。

**给排序加 `importance` 之外的第二排序键 (如 validAt 新的优先)。** 否掉:
那是**语义偏好**(新记忆更重要), 而本缺陷要的是**确定性**。用 id 作 tiebreak 不带任何语义,
不会在"该注入哪条"上偷偷改变既有行为。

**删除 line 首标记改成行尾标记里加 kind (如 `<!--hx-memory:id=x;kind=rule-->`)。**
对模型完全不可见 ⇒ 框架句那句承诺仍然指代不到 —— 而本条改动的目的**就是**让它可见。
机器侧其实也不需要 kind (解析只用 id), 所以两个位置各服务一个读者。

## Consequences

换来的: 候选集合不再混入 lesson/context/pattern (实测候选 **438 → 32 条**; 预算 20000 时注入
**92 → 32 条**, 即修复后被短路的条目已全部消失); 两入口与反转输入的结果**完全一致**;
注入块每条自证效力等级
(9 条实测 861 字符, 其中 kind 标记 73 字符 ≈ 正文 401 字符的 18% —— 比 2026-09-15 删掉的
`[id]` 句柄 (180 字符) 便宜得多, 且它换的是**语义可辨**, 不是可选句柄)。

付出的: kind 白名单多了一处需要随之维护的**封闭集合**(新增 kind 时必须回答"它该不该常驻");
注入块每条多约 7 字符; 排序多一次 id 比较。三条覆盖不到的诚实边界见下。

## Honest limits (未解决, 本次**没有**修)

**跨 kind 的"推翻"关系仍然发现不了 —— 这是真实的注入污染源, 且不在选取层。**
实测事故形态: `c82a7b72b20019609` (`decision`, "改用 kb-index.ts 按 H2 切片") 已被同日的
`c06a0decde30c4a88` (`context`, "废弃按 ## 切片…**否掉** kb-index.ts 的 H2 切片方案") 在**语义上**推翻,
但两条都是 `status: active`、之间只有**无向 `relates`** 边 ⇒ 保底通道**每轮都在注入被推翻的那条**。

实测根因 (直接调 `decideEvolution` 复现): 该判据对这两条给出 **`add`**
(`coverage 0.079`, `similarity 0.000`) —— 因为它要求取代/冲突**同 kind + 高覆盖率**,
而这两条 kind 不同、字面重叠极低。真实库里 `supersedes`/`supersededBy`/`contradicts` 边数为
**0 / 0 / 0** (只有 relates 2190 + generalizes 60) ⇒ **没有数据可供下游使用**。

选取层对此无能为力: 它只能看 `status`, 而 `always-on.ts` 已经用
`(e.status ?? "active") !== "active"` 把 `superseded` 挡在外面 —— 这条路是**通的**, 缺的是"谁来标记"。
⇒ 修复点在**写入期的跨 kind 判定**, 需要另一套判据 (例如"显式否决信号 + 同一实体/同一决策对象"),
本次不猜、不实现。已用测试把"选了 status 这条路就有效"这一既有保证单独钉住
(`### 负例: 被取代 (superseded) 的条目不进常驻`), 使缺口**可见**而不是静默。

## Testing

- `tests/s2/always-on-kind-whitelist.test.ts` (新增, 10 项): **每一条断言都传 lineage**
  (原测试漏的正是这一点); 负例覆盖 lesson / context / pattern / doc / 跨项目 / superseded;
  正例覆盖 decision 放行、global fact 保留原有行为、白名单函数对 `MemoryKind` **全值域穷举**;
  另钉两条**确定性**性质 (反转输入 → 同集合; 同输入两次调用 → 一致)。
- `scripts/mutation-probe.ts` 新增 3 条变异 (全部 CAUGHT, 15/15 无 SKIP):
  `白名单被 scope 绕过` / `排序丢掉确定性 tiebreak` / (同步更新的) `放宽项目隔离`;
  另同步了两条因本次改动而 "原文串不匹配" 的旧变异 (`formatRetrieval 退回旧行格式`)。
- 既有测试同步: `tests/s1/binder.test.ts` 与 `tests/s2/injection-format-single-source.test.ts`
  的行格式断言按新语义更新 (并断言**不出现** `[规则]` 双重标记)。
- 全量: `npx vitest run tests/s1 tests/s2 tests/s3` → **167 文件 / 1146 测试通过**;
  `pnpm run mutation-probe` → 15/15 拦住。
- 真库复核 (副本, 未动生产库): 修复前候选 438 条含 lesson 348; 修复后候选 32 条
  (rule 9 / decision 17 / fact 4 / preference 2), 两入口逐条一致。

## 落点与陈旧事实同步

本改动改变了"注入行长什么样"这一**已发布事实**, 故同批更新:
[注入去重与差量注入](2026-09-11-injection-dedupe-and-delta.md) 的行格式描述。
[注入行去掉行首 id 句柄](../simplification/2026-09-15-drop-injected-id-handle.md) 的记录**仍然有效**
(它讲的是删 `[id]` 句柄, 本次加的是性质不同的 `[kind]` 标记), 未改动其结论。

**Supersede 检查**: 遍历活跃树后判定为**部分取代** —— 本 Note 补充
[always-on 的项目隔离](2026-09-15-alwayson-project-isolation.md) 的 scope 侧判据 (那篇讲"不知道项目就一条不给"),
并修订 [触发层四通道](2026-09-10-trigger-layer-four-channels.md) 里 always-on 的 kind 边界;
两篇的**决策本身未被推翻**, 故都保持活跃、不归档, 由本 Note 互相链接。
