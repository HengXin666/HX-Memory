# 工程约束 (engineering)

## 目标

HX-Memory 是一个**自维护、可插拔**的记忆层: 内核 (Port) 只定义抽象, 不依赖任何 harness 或存储实现; DSH / Codex / CLI 是接入层 adapter; 文件 / SQLite / 向量是存储 adapter; 推广引擎 (Generalizer) 是核心差异。

## 架构铁律

1. **依赖方向单向**: `src/kernel/` 只依赖领域概念 (types.ts), 不 import 任何 harness (DSH/Codex) 或存储驱动。违反此规则的 import 视为 bug。
2. **接入层 = 1 套 API 的多个实现**: `HarnessAdapter` 是 pull 式 harness 端口 (Codex); DSH 是事件驱动, 走 runtime/binder/recall/gateway 组合。新增 harness 只写新 adapter, 内核与存储零改动。
3. **端口必须有实现**: `FileBackend implements MemoryStore`, `GeneralizerService implements Generalizer`; `tests/s1/ports.test.ts` 用类型断言钉住, 不许出现"只写在文档里的端口"。
4. **存储层可插拔**: 一切持久化走 `MemoryStore` 接口; 具体后端只实现接口, 内核不感知。
5. **真相在文件, 索引可重建且往返无损**: 文件 (Markdown) 是事实源; relations/tags/structured 必须写回文件并可被 `rebuildFromFiles()` 读回; 删索引不影响真相; 撤回 (`remove`) 在文件里写 `status: shadow`。
6. **双时态**: 每条记忆带 `validAt` + `assertedAt`, 回答"以前是什么"靠时间切片。
7. **抽象必须人工闸门**: 推广引擎只提议 (后台/面板/工具), 不自动确认; rule 的确认记录必须留存 (谁/何时/覆盖实例)。
8. **宿主契约必须真机验证**: 组合层 (`isolate`)、client bundle 模块 id、RPC 约定 (`/api` + `hxMemory/<method>` + `{args}` + `{ok,value}`) 三类问题只有真机跑一遍才看得见; `scripts/smoke-dsh.sh` 是门禁。
9. **不重复造市面轮子, 但也不整包引入**: 抄设计思想 (supersedes 演化链/分层召回/daily→digest), 代码全部自维护。

## 测试分层 (hx-test-pipeline 约定)

- **static**: `pnpm exec tsc --noEmit` (内核) 与 `tsc -p tsconfig.client.json` (前端) 是所有层之前的基础门禁。
- **S1** (`tests/s1/`): 纯业务规则、内核状态转换、双时态切片、端口一致性、推广工作流的状态机; 进程内运行, 禁止网络。
- **S2** (`tests/s2/`): adapter/存储契约、工具契约、假 harness 事件流、client RPC 约定、设置生效; 使用临时资源与 stub。
- **S3** (`tests/s3/`): 事件接线 (假 harness 事件序列)。
- **真机门禁** (`scripts/smoke-dsh.sh`): 隔离 `DSH_HOME` 装插件 → 启 web host → 断言 fiber 状态 / RPC 200 / bundle 模块 id; CI 由 `boot-smoke.yml` 跑。
- **S4** (CI 独立/定时, 未实现): 真实 LLM 推广质量 canary, 不阻塞普通 PR。
- 每个高风险业务行为要有可观察断言, 不 mock 调用即 PASS; SKIP 不伪装 PASS。
- 统一入口: `bash scripts/verify.sh` (build + static + S1/S2/S3); CI 与本地 Stop hook 都用它。

## 提交约束 (house 风格)

- 提交信息第一行: `[type] subject`, type ∈ feat fix docs style refactor perf test build ci chore revert release deps security。
- 默认不装 commit-msg hook (opt-in); 用户明确要求才 `bash scripts/install-commit-hook.sh [--force]`。
- 新文件先 self-review 再提交; 不提交 `node_modules` / `dist` / 日志 / 密钥。

## 代码风格

- TypeScript strict; `noUncheckedIndexedAccess`; ESM; 类型显式。
- 命名: 接口 PascalCase 无 I 前缀; 常量 UPPER_SNAKE; 文件 kebab-case。
- 不改动不相关的文件; 新能力先补测试再合并。
- 字符串里的正则元字符要双写: 写 `"[\\s\\S]"` 而不是 `"[\s\S]"` (后者会被解析成 `[sS]`, 真实踩过)。
- 宿主 API 漂移集中在适配层处理 (`session-events.ts` 这类能力探测), 不要在业务代码里直接读可能消失的访问器。
- 文件格式必须可逆: 正文里"看起来像元数据/块边界"的内容写入时转义; 解析器对不可解析的行 fail-closed 但不要抛断整批。

## Hook 纪律

- PostToolUse: 清理 emoji/不可见字符 + prettier (本仓库写盘文件)。
- Stop: 运行 `verify_ts.sh` 摘要, 完整日志在 `.git/hx-init/logs/`, 不把全量告警灌进上下文。
- 所有 `.sh` 写盘后 `chmod 755`。
- 不生成根 `CLAUDE.md` / `AGENTS.md`; 规则按 agent 落到实体目录.
