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

### 第二步: 找一个入口

装好后, 你会在 **DSH 设置区看到两个新面板**:

| 面板 | 在哪 | 用来干什么 |
| --- | --- | --- |
| **记忆审阅** | DSH 设置 → 记忆审阅 | 攒了一批推广提议时, 逐条**确认/驳回** |
| **记忆绑定** | DSH 设置 → 记忆绑定 | 为每个项目声明"要绑哪些记忆源"(VCP 式拓扑) |

### 第三步: 正常聊天, 剩下的交给它

记忆捕获是**自动的**: 你在对话里踩坑、做决策、表偏好, 都被隐式记下; 也可以直接说 "记住 X"。

---

## 使用入口 (你可以在哪些地方触达它)

| # | 入口 | 在哪里 | 怎么触发 | 你会得到什么 |
| --- | --- | --- | --- | --- |
| ① | **自动捕获** | 任何 DSH 会话 | 正常对话 (踩坑/决策/偏好被隐式记录); 或说 "记住 X" | 记忆落盘 → 之后的会话自动想起 |
| ② | **绑定管理面板** | DSH 设置 → 记忆绑定 | 打开面板, 为项目声明记忆源拓扑 (查询/权重/信号词) | 可视化增删改, 保存即生效 |
| ③ | **审阅面板** | DSH 设置 → 记忆审阅 | 收到推广提议时, 逐条确认/驳回 | 确认的提议变成全局规则 |
| ④ | **确定性注入** (自动) | 每个 `agent/pre-step` | 绑定命中的项目, 每次对话自动注入绑定记忆 | 模型每步都带着相关记忆 (测试 10/10 命中) |
| ⑤ | **记忆工具** (模型可调) | DSH 工具区 | 模型自主调用 `memory_search` / `memory_save` / `memory_rule_propose` | 按需检索 / 保存 / 提议规则 |
| ⑥ | **Codex CLI** | 终端 | `node dist/adapters/codex/cli.js sync/rules` | 把全局规则同步进某仓库 AGENTS.md / 列出已确认规则 |

> 简单说: **① 自动记, ④ 自动注入, ② 管绑定, ③ 管推广, ⑤ 手动兜底, ⑥ 换宿主用**。

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

**双线对照测试自证** (`tests/s2/dual-line.test.ts`): 旧线 (靠模型自觉调 memory_search) 10 轮命中 6; 新线 (声明式绑定 + 确定性注入) **10/10**。

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
- 双时态 `validAt` / `assertedAt`; `supersedes` 演化链 (覆盖不丢史, 并列不碎片)。
- `project` 是第一等字段: 本地经验按项目隔离, 全局规则跨项目生效。

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
    dsh/           #   DSH (cordis 插件: 会话捕获/工具/Web review 面板 + Typert gateway)
    codex/         #   Codex (AGENTS.md 同步 + CLI)
  storage/         # 存储层: FileBackend (默认, 真相在文件+SQLite 索引) / 可插拔
  index.ts
```

## 能力闭环

```text
会话捕获 → lesson 落盘 (truth-in-files) → 批量推广 → 人工确认 → 全局规则
                                                                   ↓
                任何项目的新会话 start → 召回规则注入 context (跨项目生效)
```

---

## 测试与 CI

| 层 | 位置 | 内容 |
| --- | --- | --- |
| S1 内核 | `tests/s1` (6) | 纯逻辑, 禁网络 (binder/agents-md 等) |
| S2 接入+存储 | `tests/s2` (10) | 临时资源/stub (dual-line 5 / binding-store 4 / prestep 6 / codex-adapter 3 等) |
| S3 完整 DSH | `tests/s3` (2) | 真实 DSH 接入 |
| static | `tsc --noEmit` ×2 | 内核 + client 双类型闸门 |

```bash
pnpm install
pnpm test          # S1+S2+S3
pnpm run verify    # static + 全部单测 (统一入口)
```

**CI**: `.github/workflows/ci.yml` (类型 + 单测) + `.github/workflows/boot-smoke.yml` (DSH 真机启动冒烟)。

---

## 设计决策

> 8 条 ADR 记录了每一步取舍: [docs/adr.md](docs/adr.md) · 架构分层: [docs/architecture.md](docs/architecture.md)

| ADR | 决策 |
| --- | --- |
| 001 | 自维护内核 + adapter, 不整包引入市面项目 |
| 002 | 真相在文件 (Markdown), 索引在库 (SQLite), 可重建 |
| 003 | 推广 = 后台提议 + 人工 review 队列 |
| 004 | 双时态 `validAt` + `assertedAt` |
| 005 | `supersedes` 演化链 (版本化记忆) |
| 006 | 全 TypeScript, 前端嵌入 DSH 宿主 Web |
| 007 | `project` 第一等字段 (跨项目隔离与生效) |
| 008 | "何时读记忆"由声明式绑定决定, 不靠模型自觉 (VCP 式) |

## License

Apache-2.0
