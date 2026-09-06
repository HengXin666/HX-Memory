# HX-Memory

> **自维护 · 可插拔 · 跨项目推广的 Agent 记忆层** — 让 AI 记住你的踩坑, 把"项目 A 的教训"自动变成"所有项目的规则"。

![CI](https://img.shields.io/github/actions/workflow/status/HengXin666/HX-Memory/ci.yml?label=ci)
![boot-smoke](https://img.shields.io/github/actions/workflow/status/HengXin666/HX-Memory/boot-smoke.yml?label=boot-smoke)
![license](https://img.shields.io/github/license/HengXin666/HX-Memory)
![ts](https://img.shields.io/badge/TypeScript-5.7-3178c6)

---

## 为什么需要它

大多数 Agent 的记忆系统只有**单个项目内的"记与取"**: 今天在这个仓库踩的坑, 明天换一个仓库, 同样的坑再踩一遍。

HX-Memory 补上缺的那一环 —— **跨项目推广**:

```text
在项目 A 踩坑 "我所有容器实际上都有并发策略问题"
        ↓  捕获 → 聚类 → 推广提议
        ↓  你点一下"确认"
        ↓
一条全局规则: "凡是涉及容器/并发的任务, 先检查并发策略"
        ↓  注入到 任何项目 的新会话
项目 B、C、D… 的 AI 从此都知道这个教训
```

关键: 推广是**人工闸门** —— 机器只负责提议, 没有你的确认, 规则不会落盘生效。

---

## 亮点 (这一版能干什么)

### 🧠 1. 自维护内核, 不整包引入任何市面项目

- **Port-Adapter 架构**: 内核只定义抽象接口 (零依赖), harness 与存储全是可插拔 adapter。
- 设计思想借鉴 VCP / ReMe / Hy-Memory, 但**代码 100% 自维护** —— 没有外部依赖漂移, 数据格式完全可控。
- 1 套 API, 多个接入: **DSH (cordis 插件)** / **Codex (AGENTS.md + CLI)**, 共用同一内核。

### 🎯 2. "何时读记忆"由声明式绑定决定, 不靠模型自觉 (VCP 式)

- 传统做法: 在提示词里告诉模型"你可以调 memory_search" —— 模型是概率机, 该搜时不搜 (幻觉自足), 不该搜时乱搜。
- 本版做法: 项目声明**记忆绑定拓扑** (查询条件 / 权重 / 条数 / 信号词门控), 由代码在 `agent/pre-step` **确定性注入**, 与模型自觉无关。
- 双线对照测试自证 (`tests/s2/dual-line.test.ts`): 旧线 10 轮命中 6, **新线 10/10**。
- 绑定配置存 `root/bindings.json` (真相在文件), DSH 设置面板里**可视化增删改, 保存即生效**。

### 🛡️ 3. 装上就保证 DSH 还能启动

- 专门的 **boot-smoke CI** (`.github/workflows/boot-smoke.yml`): 在全新 runner 上装 DSH → 装本插件 → 真机启动 web host → 断言插件组组合成功、进程存活、无插件加载崩溃。
- 任何会"装完 DSH 起不来"的回归都会被 CI 当场拦下。

### 📁 4. 真相在文件, 索引可重建

- 记忆本体是 **Markdown 文件** (人可读、可审计、可 git diff); SQLite 只存**派生索引**, 删库不丢真相, 索引可重建。
- 双时态 `validAt` / `assertedAt`: 记忆会说"这条是 3 月前写的, 记录的是 5 月前的事实"。
- `supersedes` 演化链: 覆盖不丢史, 并列不碎片; 版本化记忆双向指针。

### 🚀 5. 能力闭环 (已实现, 测试自证)

```text
会话捕获 → lesson 落盘 (truth-in-files) → 批量推广 → 人工确认 → 全局规则
                                                                   ↓
                任何项目的新会话 start → 召回规则注入 context (跨项目生效)
```

- **捕获**: 显式 ("记住 X") + 隐式 (踩坑/决策/偏好信号), 内容指纹去重。
- **召回**: 全局确认规则总是候选 (跨项目); 本地经验按 project 隔离按需召回。
- **推广**: 主题聚类 (信号词) + 可插拔 LLM Abstractor; 提议进 review 队列, 人工确认/驳回。
- **接入**: DSH 会话开始注入规则 + session/event 捕获 + memory_search/save 工具 + Web review 面板 + 绑定管理面板; Codex AGENTS.md 同步 + CLI。

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

---

## 快速开始

### 作为 DSH 插件

```bash
npm i -g @deepseek-ai/dsh
dsh plugin add @hx/hx-memory   # 发布后
# 本地开发: dsh plugin add file:<本仓库路径>
```

装好后 DSH 设置区会出现两个面板: **记忆审阅** (推广提议队列) 与 **记忆绑定** (项目 → 记忆源拓扑, 可视化编辑)。

### 作为 Codex / CLI

```bash
# 同步跨项目规则进某仓库的 AGENTS.md
node dist/adapters/codex/cli.js sync --root <memRoot> --repo <repoRoot>

# 列出已确认的全局规则
node dist/adapters/codex/cli.js rules --root <memRoot>
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
