# Agent Notes (方案沉淀流)

> 目的: 定义本仓库的**方案沉淀**: 每一次非平凡改动都必须留下一份"Why 与放弃了什么"的记录 —— 这部分代码与文档都承载不了。
> 边界 (不写什么): 不写使用教程 (在 README); 不写代码级细节 (在源码注释); 不写已冻结的历史决策 (在 archived/)。
> 与代码的关系: 结构由 `scripts/agent-note-tree.ts` 定义, 由 `scripts/verify-agent-note-{classification,format,coverage}.ts` 强制; 三个 gate 都挂在 `scripts/verify.sh` 与 CI 上。

## 这是什么, 与 ADR 什么关系

- **Agent Note** = 一篇一主题的方案文档 (相当于 agent 写的 RFC), 记录: 问题是什么、决定了什么、**否掉了哪些替代方案**、代价与收益。
- **`docs/adr.md`** = 编号决策日志 (历史沿革, v1/v2 期间逐条追加), 保留为可被编号引用的档案。
- 新改动**只需要 Agent Note** (硬约束, 由 gate 强制); 需要被编号引用时, 再在 `docs/adr.md` 里加一行指向该 Note。不要两边都写全文 —— 那是双份维护。

## 目录与命名

每篇 Note 的两个维度都编码在**路径**里: `{lifecycle}/{class}/yyyy-mm-dd-topic-title.md`。

- **lifecycle** (顶层目录) 是状态, Note 会随状态变化在目录间移动:
  - **`proposed/`** — 已评审待实施的提案 (尚未落地或只落一半)。
  - **`implemented/`** — 决策已上线。文件描述**已发布的事实**, 并且必须**与代码保持同步**:
    代码改路径、改包名、改默认值时, 同一改动里把 Note 里的事实改掉 (只改事实, 不改决策)。
  - **`rejected/`** — 考虑过但否掉的提案。仅当它能阻止一个**具体的、诱人的**错误时才保留, 否则删除。
- **class** (嵌套目录) 是决策类别, 取值限于封闭集合 (见下表)。
- 文件名里的日期是**首次提出**的日期。
- Note 之间互相引用必须用**相对 markdown 链接**, 不要用裸文字或编号 —— 这样是可机械校验的, 且能在移动目录后存活。
- **不要**加集中式 `INDEX.md`: 活跃树本身就是清单 (浏览 lifecycle/class 目录, 或直接搜仓库)。

### 分类 (封闭集合, 定义在 `scripts/agent-note-tree.ts`)

| Class            | 覆盖什么                                                                |
| ---------------- | ----------------------------------------------------------------------- |
| `feature`        | 面向用户或模型的新能力。                                                |
| `bug-fix`        | 修复缺陷, 或补上复盘暴露的缺口。                                        |
| `simplification` | 删除代码/行为/表面积, 不新增能力。                                      |
| `architecture`   | 关于**所发布的源码**的结构决策: 模块如何关联、运行时词汇是什么。        |
| `process`        | 代码**周边**的工具、策略、流程 (gate、包管理、脚手架), 不是运行时行为。 |
| `testing`        | 测试基础设施与策略。                                                    |

归类的分界线: **architecture 是"我们发布的源码", process 是"围绕它的工具与流程"**。
(`refactor` 刻意不在集合里 —— 它与 `simplification` 重叠, 后者的判别标准"可观察行为变了吗"已经覆盖。)

## 何时必须写一篇

**每一次非平凡改动都必须在同一批改动里新增或更新至少一篇 Agent Note**, 由 `verify-agent-note-coverage` 机械判定:

- **非平凡面** (命中即要求带 Note): `src/**`、`.agents/rules/**`、`scripts/**`、`dsh/**`、`.github/workflows/**`、`package.json`、`tsconfig*.json`。
- **豁免**: `tests/**`、`docs/**`、`README*`、`.agents/skills/**`、以及 Note 自身。
- **纯机械改动** (改名、格式化、依赖版本号): 用 `--allow-missing` 显式放行, 会打印警告而不是静默通过。

已经有一篇 Note 承载这个决策时, **更新它**即可, 不要新建重复的。只有当改动不改变行为、契约、结构、流程或理由时才算"纯机械"。

**一篇 Note 不能被编辑成"另一个决策"**: 要推翻结论就新写一篇并互相链接 (旧的置 superseded)。把 `implemented/` 的 Note 改成"决策现在住在哪里"是**要求**, 不是禁止。

## 归档与删除

已实施且"理由不再有指导价值"的 Note 才归档。判定标准不是字数或年龄, 而是这些是否还有用: 被否掉的替代方案、所有权边界、负向保证、持久化/线上语义、安全规则、以及"什么条件下该把它加回来"。

归档的硬规则 (由 `scripts/verify-agent-note-format.ts` 与人工 review 共同保证):

- 路径变成 `archived/{class}/yyyy-mm-dd-topic.md` (`implemented` 层刻意省略 —— 只有已实施的才能进归档)。
- 在 `Status: implemented` 下方插入 `Archived: YYYY-MM-DD`。
- **归档即冻结**: 之后不得编辑、重排、翻译、修复或删除; 也不再作为现状的依据。
- 归档动作是**唯一**允许的内容变更。

## 文件格式

每篇活跃 Note 的格式由 `pnpm run verify-agent-note-format` 强制。**章节标题保持英文** (它们是机器校验的 token, 不是正文), 正文用中文。

### 头部 (前三行固定)

```markdown
# Agent Note: <title>

Status: <status>
```

第四行必须是空行。`Status:` 只有三种写法, 且必须与所在生命周期目录一致 (gate 交叉校验):

- `Status: proposed`
- `Status: implemented`
- `Status: rejected — <一句话原因>`

Status 不带日期、不带括号补充: 日期在文件名里, 其余在 git 里。**拒绝原因**是唯一带内容的 status —— 因为读者来就是看这个结论。

### 正文骨架

正文第一节必须是 `## Problem` (动机, 要能脱离方案独立读懂)。之后按生命周期:

#### `proposed/`

```markdown
## Problem

## Proposal

…按需的技术章节…

## Alternatives considered

## Acceptance criteria

## Risks
```

允许未来时态 (计划、迁移步骤、开放问题都放这里)。`## Acceptance criteria` 说明"什么可观察状态算完成"; `## Risks` 同时写"可能出什么错"与"这次明确放弃了什么"。

#### `implemented/`

```markdown
## Problem

## Decision

…按需的技术章节…

## Alternatives considered

## Consequences
```

`## Decision` 用**现在时**描述已发布的事实; 整篇文件与代码保持同步。`## Consequences` 记录这次取舍**付出了什么、换来了什么**。
提案期措辞 (`## Proposal`、`## Plan`、`## Migration plan`、`## Acceptance criteria`) 在此**被 gate 拒绝**; 把"由什么测试钉住"写成现在时的 `## Testing` 或 `## Verification` 即可。

#### `rejected/`

被拒绝的 Note 是**冻结的提案**: 保留它提案期的章节 (含 `## Acceptance criteria`、`## Plan`), 结论只写在 `Status:` 行。只要求头部、`## Problem`、`## Proposal`, 以及下面的 Alternatives 强制项。

### Alternatives considered (强制)

每篇 Note 都必须有 `## Alternatives considered`: 逐个写出**真实考虑过**的替代方案以及它为什么输了 (每个方案一段, 以粗体开头; 或有争议的用 `### Why not <X>?` 子节)。**没有记录"否决了什么"的决策, 一定会被反复重新争论** —— 这正是 Agent Note 存在的意义。
替代方案是**记录**出来的, 不是编出来的。

### 生命周期之间怎么移动

移动文件就要在同一改动里改 `Status:` 行并满足目标目录的骨架, 否则 gate 失败:

- `proposed/` → `implemented/`: 把 `## Proposal` 改写成现在时的 `## Decision`, 把 `## Acceptance criteria` 与 `## Risks` 折进 `## Consequences` (或写成现在时的 `## Testing`/`## Verification`), 删掉计划, 只留已发布的事实。
- `proposed/` → `rejected/`: 只在 `Status:` 行加原因, 然后冻结。
