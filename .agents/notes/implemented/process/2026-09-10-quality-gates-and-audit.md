# Agent Note: 质量闸门 (lint / 结构 / 端口纯度 / 单一事实源) 与实测审计

Status: implemented

## Problem

用数据审了一遍当前架构 (见 [docs/quality-audit.md](../../../../docs/quality-audit.md)), 结论是**架构骨架健康但缺机械约束**:

- **拓展性好**: 分层单向 (有测试钉住)、端口可插拔 (2 个存储实现 + 50 项 conformance)、三种 Surface 共用 Facade、零运行时依赖、三级以上相对导入 0 处。
- **但存在四类持续劣化的入口**, 它们都不会让功能测试变红:
  1. **未使用的代码**: `evolve.ts` 的 `conflictFloor` 声明了却从未使用 —— 一个"看起来能配、实际无效"的选项 (真 bug);
  2. **重复实现**: jscpd 实测 4 处 clone —— 更严重的是"文本→词集"在 `ranking.ts`/`trigger/policy.ts`/`associate.ts` **各写一份**, 而它们分别服务于去冗余/话题漂移/去重裁决 —— 口径分叉会让同一对文本在不同环节得出**互相矛盾的相似度**, 且不报错;
  3. **端口泄漏**: 5 个适配层文件直接 import 具体存储类 (`FileBackend`), 其中 `gateway.ts` 的 `Pick<FileBackend, "recent">` 纯粹是**端口缺口**逼出来的 —— 会让"换引擎"必须改适配层;
  4. **规模集中**: `file-store.ts` 1373 行, 承担 5 个职责, 复杂度全仓最高。

## Decision

### 1. 审计文档化
新增 `docs/quality-audit.md`: 用可复核的命令给出拓展性/可维护性结论 + 实测清单 + DSH 约束体系对照 + 建议闸门排序。**结论要能被复核, 不是主观感受**。

### 2. 四道新闸门 (全部挂进 `scripts/verify.sh`)

- **`pnpm run lint`** (oxlint, 19 条规则): 只开高价值且低噪声的 —— `no-unused-vars` (刚抓到真 bug)、`no-unsafe-optional-chaining`、`no-useless-escape`、`prefer-const`、`no-unreachable` 等。**不照搬 DSH 的全量 type-aware 规则集**: 那需要 tsgolint 与显著的运行成本, 而我们的痛点是具体的几类。
- **`verify-structure.ts`** 四条约束:
  1. 单文件 ≤ 400 行 (纯逻辑 .ts; 前端豁免) —— 初版是 1400 的止血阈值, 已由
   [400 行约束与拆分](2026-09-11-400-line-limit-and-split.md) 收紧并按职责拆完;
  2. 重复率 ≤ 1% (jscpd 机器可读输出; 当前 0.45%);
  3. **端口纯度**: 适配层不得值导入具体存储实现 —— **组装根白名单** (`dsh/index.ts`、`codex/cli.ts`) 是唯一例外 (总得有人 `new FileBackend` 把实现接起来); 白名单之外一律拒绝, 新增组装点必须改脚本 (改动可见, 不会被悄悄绕过);
  4. **单一事实源**: `tokenSet`/`fnv1a32`/`l2Normalize`/`contentFingerprint`/`termStreams` 各自只允许一处定义, 且必须在指定文件。

### 3. 修掉审计发现的全部问题

- `conflictFloor` 真正生效 (取代用 `supersedeFloor`、冲突用 `conflictFloor`, 门槛不同是刻意的 —— 标记冲突比推翻结论安全);
- "文本→词集"统一到 `kernel/cjk.ts: tokenSet`; 哈希与 L2 归一化统一到新的 `kernel/hashing.ts`;
- recall 的两处注入格式化合并为 `formatSections`;
- **补端口缺口**: 新增 `MemoryOperations` (同步面 + `recent`/`ftsStatus`/`close` 三个可选能力), 适配层改依赖端口 —— `gateway` 的 `Pick<FileBackend>` 写法随之消失;
- 修掉 lint 报出的全部 20 条 (含一个真 bug: 模板字符串里的 `\s` 被折叠成 `s`, 导致子进程错误过滤正则失效)。

## Alternatives considered

**照搬 DSH 的全套 (40+ gate, type-aware oxlint 全量规则)。** 它的价值建立在多包 monorepo、双语配对与生成式目录上; 我们是单包、单一语言、无生成物。照搬只会得到大量需要维护的豁免项。取"高价值 + 低噪声"的 4 类。

**只在 CI 跑, 不挂本地。** CI 反馈太晚 (一次 round-trip 几分钟), 而这些问题的修复上下文在本地最热; `verify.sh` 既被 CI 用也被 pre-commit/Stop hook 用。

**把端口纯度检查放宽成"允许但警告"。** 警告在几次之后就会被无视 (真实经验)。改为**白名单 + 硬失败**: 例外必须显式登记, 新增例外要改脚本 —— 让"破例"成为可见动作。

**把 file-store.ts 一步拆到位 (目标 400 行)。** 当时选了先止血 (不许更差), 拆分另立任务 —— 后续在 [400 行约束与拆分](2026-09-11-400-line-limit-and-split.md) 里以"纯搬运、不改断言"的方式完成。

**给 oxlint 开 `correctness` 全类。** 跑下来 134 条诊断里 37 条是 `no-array-sort` 之类的风格偏好, 会淹没真问题; 只保留了能对应到"真实缺陷形态"的规则。

## Consequences

四类劣化入口现在都有机械拦截: 死代码/无效选项、重复实现 (尤其分词口径分叉)、端口泄漏、规模失控。
代价: ①新增一条跨文件共用的工具函数时, 若它属于"全局口径", 必须登记到 `SINGLE_SOURCE` 清单 (否则闸门报"多处定义"); ②组装根白名单意味着新增宿主入口要改一次脚本; ③行数上限的作用是"把该拆了变成会拦人的规则": 它当初在 1400 拦下 `file-store.ts`,
再次收紧到 400 后促成了按职责的拆分 (见 [400 行约束与拆分](2026-09-11-400-line-limit-and-split.md))。

## Testing

- `pnpm run lint`: 0 error (从 134 条降到 0, 其中含 1 个真 bug)。
- `pnpm run verify-structure`: 58 个源文件通过四类约束。
- 新增 `tests/s1/hashing.test.ts` 覆盖统一后的哈希/归一化 (含零向量不产生 NaN)。
- 全量 575 测试通过; 真机 DSH smoke 通过。
- 审计文档里的每条结论都配了可复核命令。
