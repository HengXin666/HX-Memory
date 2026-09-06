# HX-Memory

自维护、可插拔的 Agent 记忆层 (Port-Adapter 架构)。

> 设计背景与市面对比见 [docs/architecture.md](docs/architecture.md)。这不是对任何市面项目的照搬, 而是一个"抄设计思想、代码自维护"的内核 + adapter + 存储 + 推广引擎的组合。

## 架构一览

```text
src/
  kernel/          # 核心内核 (Port): 只定义抽象, 零依赖
    types.ts       # MemoryEntry / Relation / Query / Scope (含 project 第一等字段)
    ports.ts       # MemoryStore / HarnessAdapter / Generalizer 接口
  capture/         # 捕获引擎: turn → MemoryEntry (kind 推断/指纹去重/双时态) + pipeline
  recall/          # 召回引擎: 全局规则跨项目生效 + 项目内经验按需召回
  generalize/      # 推广引擎: 聚类 → 提议 → review 队列 (人工闸门 confirm→rule)
  adapters/        # 接入层: 1 套 API 的多个实现
    dsh/           #   DSH (cordis 插件: 会话捕获/工具/Web review 面板 + Typert gateway)
    codex/         #   Codex (AGENTS.md 同步 + CLI)
  storage/         # 存储层: FileBackend (默认, 真相在文件+SQLite 索引) / 可插拔
  index.ts
```

## 工程约束 (脚手架已就位)

| 约束                            | 落点                                                                                      |
| ------------------------------- | ----------------------------------------------------------------------------------------- |
| 测试分层 (static/S1/S2/S3/S4)   | `tests/s1`, `tests/s2`, `tests/s3`, `scripts/verify.sh`                                   |
| 统一验证入口                    | `bash scripts/verify.sh` (CI 与本地 Stop hook 共用)                                       |
| 文档约束 (读者视角/标点/双时态) | `.agents/rules/docs.md` (+ .claude/.codex 实体副本)                                       |
| 工程约束 (架构铁律/测试/提交)   | `.agents/rules/engineering.md` (+ .claude/.codex 实体副本)                                |
| Agent hooks                     | `.claude/hooks.json`, `.codex/hooks.json` (PostToolUse 清理+格式化, Stop 验证摘要)        |
| 提交格式                        | `[type] subject`; 默认不装 commit-msg hook, opt-in: `bash scripts/install-commit-hook.sh` |
| CI                              | `.github/workflows/ci.yml` (pnpm + verify.sh)                                             |

## 能力闭环 (已实现, 测试自证)

```text
会话捕获 → lesson 落盘 (truth-in-files) → 批量推广 → 人工确认 → 全局规则
                                                                   ↓
           任何项目的新会话 start → 召回规则注入 context (跨项目生效)
```

- **捕获**: 显式 (记住 X) + 隐式 (踩坑/决策/偏好信号), 内容指纹去重, 双时态。
- **存储**: Markdown 真相 + SQLite 索引 (可重建), rule 必须有确认记录才落盘。
- **推广**: 主题聚类 (信号词) + 可插拔 LLM Abstractor; 提议进 review 队列, 人工确认/驳回。
- **召回**: 全局确认规则总是候选 (跨项目); 本地经验按 project 隔离按需召回。
- **接入**: DSH (cordis 插件: 会话开始注入规则, session/event 捕获, memory_search/save 工具, Web review 面板) 与 Codex (AGENTS.md 同步 + CLI) 共用同一内核。

## 用法 (Codex / CLI)

```bash
# 同步跨项目规则进某仓库的 AGENTS.md
node dist/adapters/codex/cli.js sync --root <memRoot> --repo <repoRoot>

# 列出已确认的全局规则
node dist/adapters/codex/cli.js rules --root <memRoot>
```

DSH 侧以 cordis 插件加载 (见 dsh/cordis.patch.yml), 审阅面板在宿主设置区。

## 开发

```bash
pnpm install
pnpm test          # S1+S2
pnpm run verify    # static + S1+S2 (统一入口)
```

## License

Apache-2.0
