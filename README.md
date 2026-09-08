# HX-Memory

> **自维护 · 可插拔 · 跨项目推广的 Agent 记忆层** — 让 AI 记住你的踩坑, 把"项目 A 的教训"自动变成"所有项目的规则"。

![CI](https://img.shields.io/github/actions/workflow/status/HengXin666/HX-Memory/ci.yml?label=ci)
![boot-smoke](https://img.shields.io/github/actions/workflow/status/HengXin666/HX-Memory/boot-smoke.yml?label=boot-smoke)
![license](https://img.shields.io/github/license/HengXin666/HX-Memory)
![ts](https://img.shields.io/badge/TypeScript-5.7-3178c6)

---

## 它解决什么问题

大多数 Agent 记忆系统只有**单个项目内的"记与取"**: 今天在这个仓库踩的坑, 明天换一个仓库, 同样的坑再踩一遍。

HX-Memory 补上缺的那一环 —— **跨项目推广**:

```text
在项目 A 踩坑 "我所有容器实际上都有并发策略问题"
        ↓  自动捕获 → 聚类 → 生成推广提议
        ↓  你打开面板点一下"确认"
        ↓
一条全局规则: "凡是涉及容器/并发的任务, 先检查并发策略"
        ↓  自动注入到 任何项目 的新会话
项目 B、C、D… 的 AI 从此都知道这个教训
```

**没有你的确认, 机器不会推广任何规则** —— 推广是人工闸门, 不是 AI 自作主张。

---

## 快速上手 (30 秒看懂怎么用)

### 第一步: 装上

```bash
npm i -g @deepseek-ai/dsh
dsh plugin add @hengxin666/hx-memory   # 发布后; 本地开发: dsh plugin add file:<本仓库路径>
```

**版本**: 插件声明 `peerDependencies: @deepseek-ai/dsh-* ^0.1.2-rc.1`, 但两条宿主路径都实测可用:

- 设置面板: 0.1.2-rc.1 走 `ctx.settings.installSection` (接住权威配置 thunk); 0.1.1 走
  `ctx.settings.register(ns, schema, { base })` + `scope.get()`。两条路径都真的注册 `hx-memory`
  命名空间 (真机门禁断言 `settings.describe`)。
- 会话事件: 0.1.2-rc.1 移除了 `Session.events`, 插件统一经 `session-events.ts` 做能力探测
  (`eventAt(surface.nodes)` → `snapshotEvents()` → `events`), 并按 surface 过滤。

Node ≥ 22.5 (存储层用 `node:sqlite`)。

### 第二步: 找一个入口

装好后, 你会在 **DSH 设置区看到两个新面板**:

| 面板         | 在哪                | 用来干什么                                 |
| ------------ | ------------------- | ------------------------------------------ |
| **记忆审阅** | DSH 设置 → 记忆审阅 | 攒了一批推广提议时, 逐条**确认/驳回**      |
| **记忆绑定** | DSH 设置 → 记忆绑定 | 为每个项目声明"要绑哪些记忆源"(VCP 式拓扑) |

### 第三步: 正常聊天, 剩下的交给它

记忆捕获是**自动的**: 你在对话里踩坑、做决策、表偏好, 都被隐式记下; 也可以直接说 "记住 X"。

---

## 使用入口 (你可以在哪些地方触达它)

| #   | 入口                    | 在哪里                | 怎么触发                                                             | 你会得到什么                                      |
| --- | ----------------------- | --------------------- | -------------------------------------------------------------------- | ------------------------------------------------- |
| ①   | **自动捕获**            | 任何 DSH 会话         | 正常对话 (踩坑/决策/偏好被隐式记录); 或说 "记住 X"                   | 记忆落盘 → 之后的会话自动想起                     |
| ②   | **绑定管理面板**        | DSH 设置 → 记忆绑定   | 打开面板, 为项目声明记忆源拓扑 (查询/权重/信号词)                    | 可视化增删改, 保存即生效                          |
| ③   | **审阅面板**            | DSH 设置 → 记忆审阅   | 收到推广提议时, 逐条确认/驳回                                        | 确认的提议变成全局规则                            |
| ④   | **确定性注入** (自动)   | 每个 `agent/pre-step` | 绑定命中的项目, 每次对话自动注入绑定记忆                             | 模型每步都带着相关记忆 (测试 10/10 命中)          |
| ⑤   | **记忆工具** (模型可调) | DSH 工具区            | 模型自主调用 `memory_search` / `memory_save` / `memory_rule_propose` | 按需检索 / 保存 / 提议规则                        |
| ⑥   | **推广批次**            | DSH 设置 → 记忆审阅   | 点「运行推广批次」                                                   | 把最近的 lesson/decision 聚类成待审提议           |
| ⑦   | **Codex CLI**           | 终端                  | `node dist/adapters/codex/cli.js sync/rules`                         | 把全局规则同步进某仓库 AGENTS.md / 列出已确认规则 |

> 简单说: **① 自动记, ④ 自动注入, ② 管绑定, ③+⑥ 管推广, ⑤ 手动兜底, ⑦ 换宿主用**。
>
> 推广闭环有两个触发点: 面板按钮 (聚类最近的经验) 与 `memory_rule_propose` 工具 (模型直接提议)。
> 两条都只进人工队列, 都不会自动变成规则。

---

## 端到端示例 (真实场景)

**场景**: 你同时在维护多个微服务仓库, 容器并发策略的坑反复踩。

```text
1. 在仓库 A 的会话里排查一个问题, 你总结: "我所有的容器实际上都是有并发策略问题的"
   → HX-Memory 自动捕获这条经验 (隐式信号: 踩坑/决策)

2. 过一会儿, DSH 设置 → 记忆审阅 里出现一条推广提议:
   "所有容器都有并发策略问题 → 建议全局规则: 涉及容器/并发时先检查并发策略"
   → 你点【确认】

3. 打开 DSH 设置 → 记忆绑定, 给项目 B 绑定这条规则源 (或直接用全局默认)
   → 保存即生效

4. 在项目 B 开新会话, 讨论"给容器加并发限制"
   → agent/pre-step 确定性注入: 模型一上来就带着"容器→并发策略"这条经验
   → 不用你说, 它先检查并发策略 —— 而不是等你踩完坑再教它
```

**双线对照** (`tests/s2/dual-line.test.ts`): 同一条规则、同一份记忆库, 旧线 (靠模型自觉调 memory_search) 用"模型 60% 概率记得调工具"模拟出 6/10; 新线 (声明式绑定 + 确定性注入) 由代码判定, **10/10**。

> [!NOTE] 这是一条**单元级**对照 (证明"注入与否由代码决定"这一机制), 不是真实模型的命中率测量;
> 真实链路的证据是 `scripts/smoke-dsh.sh` 的真机行为门禁 (见下)。

---

## 亮点 (产品能力, 不是工程底线)

### 🧠 1. 跨项目推广: 一条经验, 所有项目受益

- 记忆的终点不是"记住", 而是"在别处也生效"。
- 机器只提议, **人工闸门确认**后才成为全局规则; 确认记录 (谁/何时/实例) 永久留存。
- 规则 → 实例双向链接, 推广可追溯。

### 🎯 2. 读记忆不靠模型自觉 (VCP 式声明式绑定)

- 传统做法: 告诉模型"你可以调 memory_search" —— 模型是概率机, 该搜时不搜 (幻觉自足), 不该搜时乱搜。
- 本版: 项目声明**记忆绑定拓扑** (查询/权重/条数/信号词门控), 代码在 `agent/pre-step` **确定性注入**, 每步用最新用户文本检索。
- 绑定配置存 `root/bindings.json` (真相在文件), 设置面板可视化编辑, 保存即生效。

### 📁 3. 真相在文件, 索引可重建, 记忆可演化

- 记忆本体是 **Markdown 文件** (人可读/可审计/可 git diff); SQLite 只存派生索引, 删库不丢真相。
- 索引重建是**无损**的: relations / tags / structured 都写进文件并可被 `rebuildFromFiles()` 读回 (有测试钉住)。
- 双时态 `validAt` / `assertedAt`; 演化链语义在 `kernel/evolution.ts` 且关联可重建。
- `project` 是第一等字段: 本地经验按项目隔离, 全局规则跨项目生效。
  项目键 = **会话工作目录的目录名** (如 `/code/api` → `api`), 捕获/绑定/召回全链路一致。

> [!NOTE] 未实现: `supersedes` 演化链目前只有"语义 + 可重建的关联", 还没有自动写入者
> (即新记忆不会自动覆盖旧记忆)。计划: 在捕获时按 (project, kind, 主题) 检测冲突并生成
> supersedes 链, 由人在审阅面板确认。

### 🔌 4. 自维护内核 + 可插拔接入

- **Port-Adapter 架构**: 内核零依赖, harness 与存储全是 adapter; 1 套 API, DSH / Codex 共用。
- 设计思想借鉴 VCP / ReMe / Hy-Memory, 代码 100% 自维护, 无外部依赖漂移。

### 🔒 5. 推广全流程人工可审

- 后台批量聚类 → 提议进队列 → 面板逐条确认/驳回 → 只有确认的落盘为全局规则。
- 不会出现"AI 擅自把一条经验推广到所有项目"的事故。

---

> **工程保证** (底线, 不是亮点): 专门的 **boot-smoke CI** 在全新 runner 上装 DSH → 装本插件 → 真机启动 web host, 断言插件组组合成功、进程存活、无插件加载崩溃。任何"装完 DSH 起不来"的回归都会被当场拦下。

---

## 架构一览

```text
src/
  kernel/          # 核心内核 (Port): 只定义抽象, 零依赖
    types.ts       # MemoryEntry / Relation / Query / Scope (project 第一等字段)
    ports.ts       # MemoryStore / HarnessAdapter / Generalizer 接口
  capture/         # 捕获引擎: turn → MemoryEntry (kind 推断/指纹去重/双时态) + pipeline
  recall/          # 召回引擎: 全局规则跨项目生效 + 项目内经验按需召回
  generalize/      # 推广引擎: 聚类 → 提议 → review 队列 (人工闸门 confirm→rule)
  kernel/binder.ts # VCP 式声明式绑定: 项目 → 记忆源拓扑, 确定性注入
  bindings/        # 绑定配置持久化 (root/bindings.json, truth-in-files)
  adapters/        # 接入层: 1 套 API 的多个实现
    dsh/           #   DSH (cordis 插件: 会话捕获/工具/Web 面板 + Typert gateway)
                   #   prestep.ts        pre-step 确定性注入 (跨 step 去重)
                   #   llm-agent.ts      agents 服务调用 (真实 create/followup/whenIdle 契约)
                   #   settings-source.ts 持有宿主设置源 thunk (设置改动能生效)
                   #   client/rpc.ts     Web 面板 ↔ gateway 的唯一 RPC 入口 (/api + {args})
    codex/         #   Codex (AGENTS.md 同步 + CLI)
  storage/         # 存储层: FileBackend (默认, 真相在文件+SQLite 索引) / 可插拔
  index.ts
scripts/
  lib/wrap-client-bundle.mjs  # client bundle 包装 (模块 id = 包名, 可单测)
  smoke-dsh.sh                # 真机 DSH 行为门禁
```

## 能力闭环

```text
会话捕获 → lesson 落盘 (truth-in-files) → 批量推广 → 人工确认 → 全局规则
                                                                   ↓
                任何项目的新会话 start → 召回规则注入 context (跨项目生效)
```

---

## 测试与门禁

| 层               | 位置                   | 内容                                                                                                           |
| ---------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------- |
| S1 内核          | `tests/s1`             | 纯逻辑, 禁网络 (binder / 端口一致性 / 双时态)                                                                  |
| S2 接入+存储     | `tests/s2`             | 临时资源/stub: 存储完整性、pre-step 去重、设置生效、agents 契约、推广触发、client RPC 约定                     |
| S3 完整 DSH      | `tests/s3`             | 事件接线 (假 harness)                                                                                          |
| static           | `tsc --noEmit` ×2      | 内核 + client 双类型闸门                                                                                       |
| **真机行为门禁** | `scripts/smoke-dsh.sh` | 隔离 `DSH_HOME` 装插件 → 启 web host → 断言 fiber active / 6 个 RPC 业务成功 / 绑定写读真往返 / bundle 模块 id |

```bash
pnpm install
pnpm run verify           # build + static + 全部单测 (统一入口)
bash scripts/smoke-dsh.sh # 真机 DSH 行为门禁 (需要 dsh + 网络)
```

**为什么要有真机门禁**: 插件可以"装得上、进程不崩、fiber active", 而面板仍然整块 404 ——
组合层 (`isolate`)、模块 id、RPC 约定这三类问题只有真机跑一遍才看得见。所以
`scripts/smoke-dsh.sh` 逐条断言 profile 组合、两个 fiber 状态、6 个 RPC 端点、
以及客户端 bundle 注册的模块 id 与 boot manifest 行 id 一致。

**数据完整性门禁** (`tests/s2/file-store-*.test.ts` + `cross-process`): 正文与 frontmatter 都不能
伪造块/字段 (写入转义 + 值域校验, 否则一条普通记忆能在重建后凭空造出"已确认规则")、索引丢失
自动从真相重建、**两个进程真并发**同时打开同一索引不报 `database is locked`、撤回是持久的、
relations/tags/structured 重建无损、CRLF/BOM/反斜杠矩阵逐字往返、更新不重排块顺序、
块外手写前言在写入后保留 (真相文件真的可手编)。

> 手写/外部工具编辑真相文件时: `valid_at` / `asserted_at` 必须是 `Z` 结尾的 ISO 串
> (`2026-07-01T00:00:00.000Z`), 否则该条目会被跳过并记 warning; 条目之间用空行分隔
> (单换行也能读, 但"正文以换行结尾 + 单换行分隔"会丢一个换行)。

**CI**: `.github/workflows/ci.yml` (build + 类型 + 单测) + `.github/workflows/boot-smoke.yml` (真机行为门禁)。

---

## 设计决策

> 8 条 ADR 记录了每一步取舍: [docs/adr.md](docs/adr.md) · 架构分层: [docs/architecture.md](docs/architecture.md)

| ADR | 决策                                                                        |
| --- | --------------------------------------------------------------------------- |
| 001 | 自维护内核 + adapter, 不整包引入市面项目                                    |
| 002 | 真相在文件 (Markdown), 索引在库 (SQLite), 可重建                            |
| 003 | 推广 = 后台提议 + 人工 review 队列                                          |
| 004 | 双时态 `validAt` + `assertedAt`                                             |
| 005 | `supersedes` 演化链 (版本化记忆)                                            |
| 006 | 全 TypeScript, 前端嵌入 DSH 宿主 Web                                        |
| 007 | `project` 第一等字段 (跨项目隔离与生效)                                     |
| 008 | "何时读记忆"由声明式绑定决定, 不靠模型自觉 (VCP 式)                         |
| 009 | 宿主契约必须真机验证: 组合层/模块 id/RPC 约定用 `scripts/smoke-dsh.sh` 钉住 |
| 010 | `project` 键 = 会话工作目录名 (而非 session id), 捕获/绑定/召回全链路统一   |
| 011 | 真相 → 索引必须无损往返 (relations/tags/structured 全部写回文件并可读回)    |

## License

Apache-2.0
