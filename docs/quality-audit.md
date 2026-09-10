# 质量约束审计 (架构 / 可维护性 / 闸门)

> 目的: 用**实测数据**回答"当前架构的拓展性与可维护性如何", 并据此确定本仓库该有哪几道质量闸门。
> 边界 (不写什么): 不写功能设计 (见 [architecture-v2.md](architecture-v2.md)); 不写市面方案对比 (见 [open-source-landscape.md](open-source-landscape.md))。
> 与代码的关系: 每一节末尾给出**可复核的命令**; 闸门落在 `scripts/verify-*.ts` 并由 `scripts/verify.sh` 汇总。
> 数据基准: 2026-09, 57 个源文件 / 10315 行 / 575 测试。

## 0. 一句话结论

**架构本身是健康的 (分层单向、零运行时依赖、无 any 无 ts-ignore), 问题集中在"局部：重复实现 + 未使用的选项 + 一处端口泄漏"。**
闸门缺的是**机械约束** (lint / 重复 / 长度), 而不是更多人工约定 —— DSH 的做法正是把约定变成可执行检查。

## 1. 拓展性评估 (好)

| 维度 | 证据 | 判断 |
| --- | --- | --- |
| 分层单向 | `tests/s1/architecture.test.ts` 5 项断言 (kernel 零宿主依赖 / 应用层不依赖适配层 / 引擎层不依赖上层 / kernel 不引 node:fs) | 好, 有测试钉住 |
| 端口可插拔 | 存储 2 个实现 + 检索/嵌入/向量/重排端口 + conformance 50 项 | 好, 新引擎按契约接入 |
| 宿主无关 | DSH / MCP(stdio+HTTP) / Codex CLI 三种 Surface 共用 Facade | 好 |
| 零运行时依赖 | `dependencies: 0`, 9 个 peer 全是宿主包 | 好 (核心资产) |
| 全量重建 | T1/T2 可重建 + 索引身份 (schemaVersion / embedderId) | 好 |
| 三级以上相对导入 | **0 处** | 好, 没有深耦合 |

## 2. 可维护性问题 (实测清单, 按严重度)

### 2.1 🔴 文档承诺的可选项被静默忽略 (真 bug)

`src/evolution/evolve.ts:119` 声明了 `const conflictFloor = opts.conflictFloor ?? 0.5`, 但**全文件没有任何地方使用它** ——
`EvolutionOptions.conflictFloor` 是一个"看起来能配、实际无效"的选项。使用者改它不会有任何效果, 也不会报错。

> DSH 用 `no-unused-vars: error` 直接拦住这类问题。这正是"局部硬编码/无效配置"的典型形态。

### 2.2 🟠 重复实现 (jscpd 实测 4 处 clone, 46 行 / 0.45%)

| 重复对 | 位置 | 性质 |
| --- | --- | --- |
| 注入文本组装 | `recall/service.ts:88-102` vs `:127-139` | **真重复**: v1 与 v2 两条路径各写了一遍"【跨项目规则】/【本项目相关经验】"格式化 |
| `hash32` (FNV-1a) | `retrieval/embedding.ts:15` vs `retrieval/embedding-lexical.ts:60` | 同一算法两份实现 |
| L2 归一化 | `retrieval/embedding.ts:61-66` vs `embedding-lexical.ts:147-152` | 同一算法两份实现 |
| `contentHash` / `quickHash` | `retrieval/vector.ts:15` vs `vector-projected.ts:14` | 同一算法两份实现 |

同类但未被 jscpd 计入的还有: `kernel/ranking.ts:169 tokenSet`、`trigger/policy.ts:132 tokenSet`、`evolution/associate.ts:57 tokenSetOf` ——
**三处各自实现"文本 → 词集"**, 而 `kernel/cjk.ts` 已有权威的 `termStreams`。分词口径一旦分叉, 检索/去重/漂移判定会给出互相矛盾的结论 (而这正是本项目的核心语义)。

### 2.3 🟡 端口泄漏: 适配层直连具体存储

`adapters/dsh/{gateway,tools,index}.ts`、`adapters/codex/{adapter,cli}.ts` 都 import 了 `FileBackend` (具体类) 而不是 `MemoryStore` (端口)。
其中 `gateway.ts:22` 的 `Pick<FileBackend, "recent">` 是**因为 Facade 没有暴露 recent 才不得不依赖实现** —— 端口缺口导致的泄漏。
影响: 换存储引擎时这些适配层要跟着改, 违背"换引擎=接线"的目标。

### 2.4 🟡 单文件过大 / 复杂度集中

`src/storage/file-store.ts` = **1373 行**, 复杂度近似值 208 (全仓最高), 且同时承担 5 个职责:
①真相文件读写 ②Markdown 解析/序列化 ③SQLite 索引 ④FTS 维护 ⑤Rebuildable 契约。
其余文件 ≤612 行, 只有它显著超出。

> DSH 用 `max-lines` / `complexity` 类规则 + 分页目录约束; 我们目前没有任何长度约束。

### 2.5 🟢 测试内的死引用 (噪声, 非风险)

21 处 `no-unused-vars` 主要在 tests (3 处 import、若干未用变量), 3 处 `no-useless-escape`。
它们不影响行为, 但会掩盖真正的问题 —— 闸门打开后这些噪声必须先清掉。

### 2.6 🟢 做得好、应保持的

- `any`: **0**; `@ts-ignore/@ts-expect-error`: **0**; 非空断言: **1**。
- 无 TODO/FIXME 残留 (由 docs gate 强制)。
- 中文注释有实际信息量 (记录踩坑原因而非复述代码)。

## 3. DSH 的约束体系 (可借鉴的部分)

DSH 有 40+ 个 `verify-*` 脚本 + oxlint (type-aware)。分四类, 我们按需取:

| 类别 | DSH 的做法 | 我们是否要 |
| --- | --- | --- |
| **静态规则** | oxlint type-aware, 规则全开 `error`: `no-floating-promises` (他们称为"最高价值的 lint bug 类")、`no-explicit-any`、`no-unused-vars`、`no-unsafe-*`、`restrict-plus-operands`、`return-await`、`unbound-method` | **要** —— 我们最该补的是 `no-floating-promises` (异步记忆层里漏 await 是真实风险) 与 `no-unused-vars` (刚抓到真 bug) |
| **结构约束** | `verify-package-dependencies` (包依赖方向)、`verify-runtime-closure` (闭包)、`verify-config-source-ownership` (配置单一owner) | **部分要** —— 我们有 `architecture.test.ts`, 但缺"配置/环境变量的单一所有权"检查 |
| **重复与规模** | `doc-budgets` (文档字数上限)、`lint-rule-fingerprint` (规则集指纹) | **要轻量版** —— 文件行数上限 + 重复块上限 |
| **文档一致性** | `verify-doc-refs`、`verify-doc-budgets`、`verify-translation-pairing`、`verify-md-links` | 已实装 `verify-docs` (引用+结构); 双语配对不适用 |

**关键差别**: DSH 的所有约定最终都落到"一条可执行命令 + 非零退出码"。我们已有的 5 道门禁就是这个模式, 缺的是**代码质量的机械约束**。

## 4. 建议新增的闸门 (按投入产出排序)

| 闸门 | 内容 | 成本 | 收益 |
| --- | --- | --- | --- |
| **G1 lint** | 引入 oxlint (零配置依赖, 二进制分发), 开 `correctness + suspicious + perf` 的 4-5 条关键规则 (`no-unused-vars`/`no-floating-promises`/`no-explicit-any`/`no-useless-escape`), 先把现有 134 条诊断清干净再收紧 | 低 (一条 npm script) | 高: 刚抓到一个真 bug; 防住整类 |
| **G2 重复检测** | `jscpd` 阈值 (当前 0.45%, 设上限 1%), 并**先修掉 4 处 clone** | 中 | 中高: 防止分词/哈希口径分叉 |
| **G3 规模约束** | 单文件行数上限 (先设 1400 并**拆 file-store**), 单函数长度上限 | 中 | 中: 复杂度集中是维护成本主因 |
| **G4 端口纯度** | 断言"适配层不 import 具体存储类"; 并补 Facade 的 `recent`/`entrySummaries` 端口以消除 `gateway` 的 `Pick<FileBackend>` | 中 | 中: 直接支撑"换引擎=接线" |
| **G5 单一事实源** | `tokenSet` 三处实现统一到 `kernel/cjk.ts`; `hash32`/`L2 归一化` 统一到一个 util | 低-中 | 高: 核心语义口径必须唯一 |

**不做**: 双语配对 (本仓库无此需求)、生成式目录 (无生成物)、包级依赖图 (单包仓库)。
