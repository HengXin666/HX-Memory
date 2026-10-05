# Agent Note: 项目祖先链可见性 (嵌套仓库不再被切成两半)

Status: implemented

## Problem

项目键取 `git rev-parse --show-toplevel` 的目录名, 在一个**嵌套仓库**结构上会把同一个人的
经验切成两半。本机实测 (2026-09-18):

| 会话工作目录 | 派生键 | 库内条数 |
| --- | --- | --- |
| `HXLoLis/components/HX-Memory` | `HX-Memory` | 31 |
| `HXLoLis` (根) | `HXLoLis` | 46 |

`git ls-tree HEAD components/` + `.gitmodules` 实测确认: `HXLoLis` 是 git 仓库, 它的
`components/` 下挂着 **3 个独立仓库** (`HX-Memory` / `HX-Workflows` / `HXLoLi-NaGaMe`,
gitlink 引用)。`git -C components/HX-Memory rev-parse --show-superproject-working-tree`
返回 `HXLoLis`, 即两者是**真实存在**的父子仓库关系。

这条缺陷的性质是它**不会让任何测试变红**: 两个键各自都是"正确"的 (都符合"仓库名"语义),
绑定匹配、always-on 过滤、意图召回、面板预填四层口径也完全一致。症状只在真实使用中浮现 ——
"在组件里工作时, 父工程沉淀的经验一条都不在", 而这正是"抓不住跨项目共通经验"最具体的机制。

同目录下的 `HX-Sagasu` **不是**独立仓库 (无 `.git`、不在 gitlink 列表、不在 `.gitmodules`),
它的键本来就是 `HXLoLis`。这一条是实测推翻假设后写下的, 避免把"看起来像组件"当成"是个仓库"。

## Decision

项目键保持**单值**不变 (存储格式与老数据一字不动), 新增**工作区祖先链**作为可见性判据:

- `kernel/project-lineage.ts`: 纯函数模块。`lineageOfToplevels` (路径链 → 仓库名链, 去重),
  `lineageVisible(entryProject, lineage)` (条目是否可见), `encodeLineage` (缓存键编码, NUL 分隔),
  `normalizeScopeArg` (字符串/对象两种标识的归一)。
- `adapters/dsh/project-key.ts`: `lineageOfCwd` 用 `--show-superproject-working-tree` **逐层向上**
  解析 (上限 8 层防御畸形/循环关系); `projectKeyOfCwd` 行为不变 (返回 `lineage[0]`)。
  非 git 目录仍回退目录名。
- 四层口径统一为"**有链按链, 无链按单值**": `selectAlwaysOn` (always-on 注入)、
  `HybridRetriever.inScope` (检索过滤)、`Binder.bindingsFor` (绑定匹配)、`trigger-cache` (缓存键)。
- `trigger-cache` 的缓存键从单值项目名改为**整条链**的编码: 可见集合由链决定, 链不同即集合不同,
  用单值当键会让链不同、键相同的两个工作区共用一份缓存。

可见性是**非对称偏序**: 子仓库看得到父工程, 父工程看不到子仓库私有的, 兄弟仓库严格互不可见。

## Alternatives considered

**把项目键改成"最外层仓库名" (合并)。** 否掉: 那样 `HXLoLis` 下 3 个组件仓库会合并成一个键,
`HX-Memory` 的私有记忆会注入进 `HX-Workflows` 的对话 —— 那是本仓库**已经修过一次**的跨项目
泄漏 (`tests/s2/trigger-cache-project.test.ts` 记录了实测: 8 个项目的条目混进一次注入)。
合并与隔离都是错的, 因为真实关系既不是"同一个"也不是"无关", 而是**祖先与后代**。

**把祖先链写进存储 (project 字段存 `"HX-Memory/../HXLoLis"` 之类的合成键)。** 否掉: 存储格式一变,
全部既有数据都要迁移, 且链在写入期被固化成一条不可追溯的合成键, 老数据无从重建 lineage。
可见性是**读取期**的性质, 不该在写入期被烧死。

**给项目键加一个"继承父工程"的布尔开关。** 否掉: 开关只表达"要不要继承", 表达不了"继承哪一层、"
"谁是兄弟"; 而且把一个可以从工作区**自动确定**的事实转嫁给用户配置 —— 用户未必知道记忆按仓库分裂,
这正是"绑定面板让人觉得没用"的一部分。

**解析时用 `git submodule status` 或读 `.gitmodules` 判断父子关系。** 否掉: 那要求当前目录
在**父**仓库里才看得到 `.gitmodules`; 而在子仓库内部工作时根本读不到它。`--show-superproject-working-tree`
从子仓库内部就能回答, 且对"用 gitlink 但缺 `.gitmodules`"的仓库同样有效。

**用绝对路径或 remote URL 当继承键。** 否掉 (与上一版决策一致): remote 可能不存在 (本地仓库)
或换域名后失效; 绝对路径不可移植 (换机器/clone 目录后记忆全部落空)。

## Consequences

- 子仓库会话能看到父工程的记忆: 本机实测可见条目 **27 → 58** (多出 31 条 `HXLoLis` 的 lesson/context),
  同时兄弟/无关仓库泄漏条目数 = **0**。
- 父工程会话看不到组件私有记忆 (方向性), 兄弟组件之间互不可见 —— 跨项目隔离没有被削弱。
- 存储格式与老数据**零迁移**: 写路径仍只写最内层仓库名; 不给链的调用点行为一字不变。
- 绑定配在父工程上时对组件内部生效 (此前完全不生效), 就近覆盖: 更具体的声明优先。
- 代价: 会话开始会多 fork 最多 8 次 git (实际上限是嵌套深度, 通常 1-2 次), 结果按 cwd 缓存;
  同名仓库 (不同路径下) 的祖先链会合并 —— 与既有"仓库名当键"的取舍一致。
- 未修 (本轮范围外): 同名仓库跨路径合并仍是已知代价; 祖先链不解决"两个不同项目共享同一份
  构建脚本库"这类横向复用需求 (那需要显式的绑定声明, 而非自动继承)。

## Testing

- `tests/s2/project-lineage.test.ts` (15 例): 祖先链解析/去重、可见性偏序四个方向 (父可见/子不可见父/
  兄弟隔离/空链不给)、NUL 编码不碰撞、写路径只写最内层、字符串旧标识归一化、`selectAlwaysOn`
  按链注入 (含"不给链退回单值"与"无上下文一律不给")、`Binder.bindingsFor` 的祖先命中与就近覆盖。
- 真实端到端 (非单测): 用本机真实库对 `/home/hx/Loli/code/HXLoLis/components/HX-Memory` 跑
  `lineageOfCwd` + `lineageVisible` 统计, 得到 27→58 且泄漏 0。
- 既存回归: `tests/s2/trigger-cache-project.test.ts` (缓存按项目隔离)、`tests/s2/project-plumbing.test.ts`
  (键派生与捕获落盘)、`tests/s2/recall-separation.test.ts` (跨项目不注入) 全部保持通过。
