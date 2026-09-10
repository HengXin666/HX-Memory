# Agent Note: release 流水线的 BUMP 未导出 (发布了 v0.1.3 而不是 v0.2.0)

Status: implemented

## Problem

手动触发 `release.yml` 并选择 `bump=minor`, 期望得到 **v0.2.0** (v0.1.2 之后有 12 个 feat),
实际发布出 **v0.1.3**。

根因是一行普通的 shell 语义: `Compute version` 步骤里写的是

```yaml
run: |
  BUMP=${{ inputs.bump }}        # ← 只是 shell 变量, 没有 export
  VER=$(node .github/scripts/calc-version.cjs)
```

`calc-version.cjs` 通过 `process.env.BUMP` 读取 bump 级别; 子进程 (node) 拿不到未导出的 shell 变量,
于是它读到 `undefined`, 走 `const k = (process.env.BUMP || 'patch')` 的默认分支 → 静默按 patch 递增。

**这个 bug 的特征值得记下**: 它不报错、不警告、流水线全绿、产物可用 —— 唯一的异常是版本号比预期小。
如果只核对"release 成功了", 就会把它当成一次成功发布放过。

## Decision

改用 workflow 的 `env:` 传参 (它天然导出给步骤内所有子进程):

```yaml
env:
  BUMP: ${{ inputs.bump }}
run: |
  VER=$(node .github/scripts/calc-version.cjs)
  echo "bump=${BUMP:-patch} version=$VER"
```

同时把 `bump` 打进取版本日志 —— 下次选错或没生效时, 日志里能直接看到, 而不是靠事后比对 tag。

## Alternatives considered

**在 `run` 里改成 `export BUMP=...` 或 `BUMP=... node ...` 同行前缀。** 两者都能修好,
但都依赖"记得写 export"这条容易再犯的约定; `env:` 是 workflow 的原生机制, 不存在忘记导出的可能。

**让 `calc-version.cjs` 默认取 `minor`。** 把默认值改成更"安全"的选项只是把问题换个方向:
patch 作为默认本身没错, 错的是"用户的选择没传进去却静默降级"。要修的是传递, 不是默认值。

**给脚本加"BUMP 缺失就退出"的严格校验。** 出发点对 (静默降级有害), 但 tag 触发路径下 BUMP 本来就该缺省
(版本由 tag 决定), 加硬校验会把合法的 tag 发布挡掉。改为**把实际生效的 bump 打日志**。

## Consequences

`workflow_dispatch` 选定的 bump 现在真的生效; tag 触发路径不受影响 (它由 `GITHUB_REF` 决定版本)。
遗留事实: 远程已存在一个 **v0.1.3** release 与同名 GitHub Packages 版本, 内容与 v0.2.0 相同
(v0.1.2 之后的 32 个提交), 只是版本号偏低。它不影响安装, 但若要清理需删除
release + tag + GitHub Packages 版本。

## Testing

- 本地复现两种写法: `( BUMP=minor; node calc-version.cjs )` → `0.1.4` (错);
  `BUMP=minor node calc-version.cjs` → `0.2.0` (对)。修复后按 env 语义传参得到 `0.2.0`。
- 结构校验: 工作流里 `env:` 传参存在、旧的错误写法已无残留。
- 修复后的工作流重新跑一次发布, 产物版本号为 `0.2.0`。
