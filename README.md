# HX-Memory

自维护、可插拔的 Agent 记忆层 (Port-Adapter 架构)。

> 设计背景与市面对比见 [docs/architecture.md](docs/architecture.md)。这不是对任何市面项目的照搬, 而是一个"抄设计思想、代码自维护"的内核 + adapter + 存储 + 推广引擎的组合。

## 架构一览

```text
src/
  kernel/          # 核心内核 (Port): 只定义抽象, 零依赖
    types.ts       # MemoryEntry / Relation / Query / Scope
    ports.ts       # MemoryStore / HarnessAdapter / Generalizer 接口
  adapters/        # 接入层: 1 套 API 的多个实现 (dsh/ 先行, codex/ 后续)
  storage/         # 存储层: FileBackend (默认) / SqliteBackend / VectorBackend(可选)
  generalize/      # 推广引擎 (Generalizer): 具体 → 一般, 人工闸门
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

## 开发

```bash
pnpm install
pnpm test          # S1+S2
pnpm run verify    # static + S1+S2 (统一入口)
```

## License

Apache-2.0
