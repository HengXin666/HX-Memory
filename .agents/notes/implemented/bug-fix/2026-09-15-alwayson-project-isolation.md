# Agent Note: always-on 的项目隔离 (兜底通道此前丢掉了 project)

Status: implemented

## Problem

跨项目记忆泄漏: 在 A 项目里能看到 **B 项目的私有决策/事实**。

实测 (live store, 117 条记忆): 生产路径上的调用 `facade.alwaysOn({ budgetTokens: 400 })`
返回 9 条, 其中包含 `[decision][project][HX-Memory] 这几个并档点的话…` —— 而这次调用
根本没有项目上下文。库里项目内候选分布在 8 个项目上 (HX-Memory 16 条、HXLoLis 15 条、
freebuff-proxy 10 条、HX-Jungle 9 条 … 共 53 条)。

两个**互相独立**的成因, 各自都足以造成泄漏:

1. **选择器的过滤条件被短路**。`selectAlwaysOn` 里判定是
   `if (opts.project && e.scope === "project" && e.project !== opts.project) return false;` ——
   当调用方没传 `project` (会话还没有工作区、或调用点忘了传) 时, 整个项目匹配被跳过,
   于是**所有项目**的项目内条目一起进入候选。而"项目内条目"的定义就是"只属于那个项目"。
2. **缓存只有一份, 且键不是项目**。`trigger-cache.ts` 用一对 `cache` / `cachedRevision`,
   失效判据是"写版本号变了"。同一版本里第一个来热身的项目把它自己项目的 always-on 灌进缓存,
   之后**所有项目**都命中这一份 —— A 项目的私有记忆被注入给 B 项目, 直到某次写入顶掉版本号。
   而接线处还额外丢了一次参数: `warm: () => refreshAlwaysOn()` (形参 `project` 没往下传),
   于是"热的那份"和"查的那份"从一开始就不是同一个项目。

## Decision

把"这是哪个项目"当成贯穿兜底通道的必要输入, 不再可省略:

- `selectAlwaysOn`: 项目内条目**必须**匹配当前项目, 判据不再挂在 `opts.project &&` 之下。
  `e.scope === "project" && e.project !== opts.project` → 挡掉。不知道是哪个项目时,
  正确答案是"一条项目内条目都不给", 而不是"全都给"。
- `TriggerSource` 的三个方法都带上 project: `alwaysOn(project)` / `recallFor(text, decision, project)` /
  `warm(project?)`; `Binder.warm(deadlineMs, query, project)` 与 `injectWithTrigger(project, …)`
  一路透传 —— 预步已经算好了 `projectOf(payload)`, 此前只是在最后一跳丢掉。
- `createTriggerCache`: 改成 `Map<projectKey, {entries, revision}>` + 每项目的在途刷新表。
  版本号仍然必要 (变了才重算), 但它是**每个项目各自**的失效依据。
- 组装根把 `project` 接到缓存上: `alwaysOn: (project) => triggerCache.ids(project)`、
  `warm: (project) => refreshAlwaysOn(project)`。

## Alternatives considered

**只修选择器, 不动缓存。** 不够: 缓存串味是独立缺陷 —— 即使选择器正确, 缓存命中的仍是
别的项目那份结果。两处都修才能让"注入的是本项目记忆"成立。

**给缓存加"最后一次 project"单槽 (命中则复用)。** 那是同一类 bug 的另一个版本:
只有一份槽位时, 两个会话交替注入就会互相顶掉 (且表现为"时好时坏", 比稳定泄漏更难查)。
按项目作键是唯一能同时满足"不串味"与"不重复查询"的形状。

**没传 project 时用"全部项目"或"当前工作区推导"。** 前者就是本缺陷; 后者让 kernel 层
去猜宿主的工作区语义 —— 而项目键的派生口径 (repo-stable project key) 属于调用方,
kernel 不该有第二份。传空 = 明确地"没有项目上下文", 行为可预测。

**把项目内条目从 always-on 里整个拿掉 (只留跨项目规则)。** 会丢掉"本项目关键事实/偏好"
这一档保底, 而它正是 LLM 没意识到要查时最有用的一类 (见 always-on 保底通道那篇)。
本次要修的是"泄漏", 不是"不要项目记忆"。

## Consequences

换来的: 每个项目只看到自己的项目内条目 + 跨项目规则 + agent 共享层;
同一进程内多个项目交替注入不再互相污染; 首轮热身热的就是本项目那一份。

付出的: 缓存条目数从 1 份变成"活跃项目数"份, 每项目每次写入版本变化各查一次库
(仍是"变了才重算", 稳态零查询); 测试与假 facade 必须跟着带 project (已更新)。
"没传 project"从"尽量给"变成"明确不给" —— 调用点漏传会表现为"没有项目记忆"
(更响的失败, 而不是静默泄漏)。

**后续 (2026-09-27)**: 同一条保底通道上又发现一个 **scope 判据短路 kind 白名单**的缺陷 ——
`scope === "project"` 分支的提前 `return` 让 kind 白名单对所有项目内条目失效 (实测混进 348 条 lesson)。
本篇的"项目隔离"决策未被推翻, 但 scope 判据的**写法**被重构为与 kind 判据正交, 见
[保底通道的 kind 白名单被 lineage 绕过](2026-09-27-alwayson-kind-whitelist-and-determinism.md)。

## Verification

- `tests/s2/trigger-cache-project.test.ts`: 先热 api 再热 web, 两边各拿到自己那份;
  未传 project 时为空; 每项目只查一次库。
- `tests/s2/recall-separation.test.ts`: 别的项目的决策不注入; 无 project 时一条都不给。
- live store 复核: `alwaysOn({})` → 8 条 (跨项目规则 + agent 共享层), 无任何项目内条目;
  `alwaysOn({project:"HX-Memory"})` → 9 条, 只多出 HX-Memory 自己那条。
