# 工程约束 (engineering)

## 目标

HX-Memory 是一个**自维护、可插拔**的记忆层: 内核 (Port) 只定义抽象, 不依赖任何 harness 或存储实现; DSH / Codex / CLI 是接入层 adapter; 文件 / SQLite / 向量是存储 adapter; 推广引擎 (Generalizer) 是核心差异。

## 架构铁律

1. **依赖方向单向**: `src/kernel/` 只依赖领域概念 (types.ts), 不 import 任何 harness (DSH/Codex) 或存储驱动。违反此规则的 import 视为 bug。
2. **接入层 = 1 套 API 的多个实现**: `HarnessAdapter` 接口之下每个 harness 一个实现; 新增 harness 只写新 adapter, 内核与存储零改动。
3. **存储层可插拔**: 一切持久化走 `MemoryStore` 接口; 具体后端 (FileBackend/SqliteBackend/VectorBackend) 只实现接口, 内核不感知。
4. **真相在文件, 索引可重建**: 文件 (Markdown) 是事实源; SQLite/向量只是派生索引, 删除不影响真相; 反向操作 (删文件) 必须被禁止或提示。
5. **双时态**: 每条记忆带 `validAt` + `assertedAt`, 回答"以前是什么"靠时间切片。
6. **抽象必须人工闸门**: 推广引擎只提议 (后台), 不自动确认; rule 的确认记录必须留存 (谁/何时/覆盖实例), 防幻觉式过度推广。
7. **不重复造市面轮子, 但也不整包引入**: 抄设计思想 (supersedes 演化链/分层召回/daily→digest), 代码全部自维护。

## 测试分层 (hx-test-pipeline 约定)

- **static**: `pnpm exec tsc --noEmit` 是所有层之前的基础门禁。
- **S1** (`tests/s1/`): 纯业务规则、内核状态转换、双时态切片、推广工作流的状态机; 进程内运行, 禁止网络。
- **S2** (`tests/s2/`): adapter/存储契约、工具契约、假 harness 事件流; 使用临时资源与 stub。
- **S3** (`tests/s3/`): 完整接入流程, 真实 DSH plugin 装载; 外部可控 (本地 mock server)。
- **S4** (CI 独立/定时): 真实 LLM 推广质量 canary, 不阻塞普通 PR。
- 每个高风险业务行为要有可观察断言, 不 mock 调用即 PASS; SKIP 不伪装 PASS。
- 统一入口: `bash scripts/verify.sh` (static + S1/S2); CI 与本地 Stop hook 都用它。

## 提交约束 (house 风格)

- 提交信息第一行: `[type] subject`, type ∈ feat fix docs style refactor perf test build ci chore revert release deps security。
- 默认不装 commit-msg hook (opt-in); 用户明确要求才 `bash scripts/install-commit-hook.sh [--force]`。
- 新文件先 self-review 再提交; 不提交 `node_modules` / `dist` / 日志 / 密钥。

## 代码风格

- TypeScript strict; `noUncheckedIndexedAccess`; ESM; 类型显式。
- 命名: 接口 PascalCase 无 I 前缀; 常量 UPPER_SNAKE; 文件 kebab-case。
- 不改动不相关的文件; 新能力先补测试再合并。

## Hook 纪律

- PostToolUse: 清理 emoji/不可见字符 + prettier (本仓库写盘文件)。
- Stop: 运行 `verify_ts.sh` 摘要, 完整日志在 `.git/hx-init/logs/`, 不把全量告警灌进上下文。
- 所有 `.sh` 写盘后 `chmod 755`。
- 不生成根 `CLAUDE.md` / `AGENTS.md`; 规则按 agent 落到实体目录.
