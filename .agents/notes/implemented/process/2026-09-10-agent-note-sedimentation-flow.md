# Agent Note: Agent Note 沉淀流 (硬约束的方案记录)

Status: implemented

## Problem

本仓库此前的方案记录只有 `docs/adr.md`: 它是**编号决策日志**, 逐条追加, 但不记录"否决了哪些替代方案", 也没有任何机制保证"改了非平凡代码就必须留记录"。结果是: 一个决策在本会话里被讨论了三次 (改分层、改索引方案、换嵌入器), 前两次的结论与理由只存在于对话里 —— 换一个 agent、换一次会话就全部丢失, 于是同一个问题被反复重新争论。

上游 deepseek-harness 用 `.agents/notes/` 解决了这件事: 一篇 Note 一个主题, 记录动机、决策、**被否掉的替代方案**、代价, 由 `scripts/verify-agent-note-{classification,format}.ts` 两个 gate 强制格式与分类。

## Decision

在本仓库实装同构的沉淀流, 并把它做成**比上游更强的硬约束** (上游的"非平凡改动必须带 Note"靠 AGENTS.md 说明 + 自觉, CI 只校验已有 Note 的格式):

- **树**: `.agents/notes/{proposed,implemented,rejected,archived}/{class}/yyyy-mm-dd-topic.md`。lifecycle 是状态 (会移动), class 是决策类别。
- **分类封闭集合** (定义在 `scripts/agent-note-tree.ts`, 拼错目录名当场拒绝): `feature`、`bug-fix`、`simplification`、`architecture`、`process`、`testing`。
- **三个 gate, 都挂进 `scripts/verify.sh` 与 CI**:
  1. `verify-agent-note-classification.ts` — 路径/文件名/封闭集合, 并禁止历史路径 (`docs/rfc` 等) 复活;
  2. `verify-agent-note-format.ts` — 头部三行 (标题 / 空行 / Status)、Status 与目录**交叉校验**、第一节必须是 `## Problem`、按生命周期的必需章节 (proposed: Proposal/Acceptance criteria/Risks; implemented: Decision/Consequences; rejected: Proposal)、implemented 禁提案期措辞、`## Alternatives considered` 必填、只允许一行 Status;
  3. `verify-agent-note-coverage.ts` — **上游没有的机械判定**: 基于 git diff, 改到 `src/**`、`.agents/rules/**`、`scripts/**`、`dsh/**`、`.github/workflows/**`、`package.json`、`tsconfig*.json` 时, 同一批改动里必须出现 Note, 否则退出码 1。
- **低摩擦入口**: `pnpm run notes:new -- --lifecycle ... --class ... --title "..." --slug ...` 生成合规骨架 (人只填内容)。
- **本地硬拦**: pre-commit hook (`.agents/hooks/check_agent_notes.sh`) 跑同样三条; `bash scripts/install-commit-hook.sh` 同时装 commit-msg 与 pre-commit。
- **冻结区**: `archived/` 只进不改, 归档动作是唯一允许的内容变更 (补 `Archived: YYYY-MM-DD`)。
- **与 ADR 的分工**: 新决策只写 Agent Note; `docs/adr.md` 保留为可编号引用的历史档案, 需要时加一行指向 Note, 不写双份全文。

## Alternatives considered

**只更新 `docs/adr.md`, 不建新树。** 最省事, 但 ADR 格式没有"被否掉的替代方案"的强制位, 也没有任何 gate —— 而恰恰是"否决了什么"最能防止重复争论。且 ADR 的编号序列会无限增长, 无法按主题检索。

**照抄上游的"自觉 + 格式 gate", 不做覆盖率 gate。** 上游确实只做格式与分类校验, 靠 AGENTS.md 说明约束 agent。但本仓库是单人 + 多 agent 协作, 没有 PR review 兜底; 实测"自觉"在这种情况下会退化成"忘记写"。因此加了基于 diff 的机械判定。

**引入 `tsx` 依赖来跑 gates。** 上游用 `tsx scripts/*.ts`。本仓库坚持零运行时依赖, 且 Node 24 的 strip-only 模式能直接跑 TS —— 用 `node --experimental-strip-types` 即可 (代价: 不能使用 TS 参数属性等非可擦除语法, 已由既有踩坑记录覆盖)。

**用文件数量/字数阈值决定是否归档。** 已被上游明确否定: 判断标准应是"理由是否还能指导后续工作"(被否的替代方案、所有权边界、负向保证、安全规则、重新引入条件), 不是体量。

## Consequences

方案记录从"对话里的临时共识"变成"仓库里可检索、可 diff、被 gate 保护的资产"; 同一个问题不会在被遗忘后重新争论。代价有三: ①每次非平凡改动多一步写 Note 的成本 (收益是它强制你想清楚否决了什么); ②gate 本身需要维护 (新增类别要同时改 `agent-note-tree.ts` 与 README); ③CI 里的覆盖率判定必须给比较基线 (工作区在 CI 是干净的), 已用 `HX_NOTE_COVERAGE_BASE` 处理。

## Testing

`tests/s1/agent-note-gates.test.ts` (18 项): 逐个构造违规样本并断言 gate **真的拒绝** —— 错误标题、Status 与目录不一致、第一节不是 Problem、缺 Decision/Consequences、implemented 里的提案期措辞、缺 Alternatives、重复 Status、未知 lifecycle/class、深度错误、无日期文件名、INDEX.md、归档缺 Archived 行; 同时断言合法样本通过 (防止过严到无法落地)。
`tests/s1/agent-note-coverage.test.ts` (8 项): src 改动无 Note → 拒绝; 带 Note → 通过; 纯测试/文档 → 豁免; 规则/脚本/CI/包配置 → 非平凡。
端到端证据: 注入一篇违规 Note 时 `verify-agent-note-format` 退出码 1 并逐条指出问题; pre-commit 在"改了 `src/kernel/ranking.ts` 但没带 Note"时退出码 1, 加上 Note 后通过。
