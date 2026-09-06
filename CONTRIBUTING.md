# Contributing

## 提交前自查

1. `bash scripts/verify.sh` 通过 (static + S1 + S2)。
2. 文档遵守 `.agents/rules/docs.md` (读者视角、标点、无 TODO/emoji/本地路径)。
3. 架构遵守 `.agents/rules/engineering.md` (依赖单向、接口化、双时态、人工闸门)。
4. 提交信息 `[type] subject` (type: feat fix docs style refactor perf test build ci chore revert release deps security)。
5. 新行为有可观察断言 (S1/S2); 真实 LLM 推广用例走 S4, 不阻塞 PR。

## 提交流程

```bash
git add <files>
git commit -m "[feat] describe the change"
```

默认不强制 commit-msg hook; 若你希望本仓库强制格式, 一次性启用:

```bash
bash scripts/install-commit-hook.sh   # 或 --force 覆盖已有 hook
```

## 规则文件位置 (禁止软链)

- 规则与 hooks 在 `.claude/` 与 `.codex/` 下都是**实体文件** (Claude/Codex 各自读取自己的目录)。
- `.agents/` 是共享母本与安装记录 (`.agents/.install-manifest.json`), 不是软链目标。
- 修改规则: 改 `.agents/rules/*.md` 后**同步复制**到 `.claude/rules/ ` 与 `.codex/rules/` (写真实文件)。
- 修改 hooks: 改 `.agents/hooks/*.sh` 后**同步复制**到两个 agent 的 hooks 目录, 并 `chmod 755`。

## 分层测试速查

| 目录         | 内容                                       | 网络            |
| ------------ | ------------------------------------------ | --------------- |
| `tests/s1/`  | 内核纯逻辑 (类型/双时态/演化链/推广状态机) | 禁              |
| `tests/s2/`  | storage/adapter 契约, stub/fixture         | 禁              |
| `tests/s3/`  | 完整接入 (DSH plugin 装载)                 | mock            |
| S4 (CI 定时) | 真实 LLM 推广质量                          | 真实, 不阻塞 PR |
