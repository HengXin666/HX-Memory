# REPORT-BUILD — 评测页 (docs/eval-report.html) 接进 scripts/verify.sh

生成: 2026-11-01 20:30 CST。

## 接法

- `scripts/eval/report.ts` 本来就由每个评测脚本跑完时调 `writeReport()` 重画; 但 `verify.sh` 不跑评测, 所以只跑门禁时页面不会动。
- 新增 `scripts/eval/report-refresh-check.sh`: 记下开始时间 → `node --experimental-strip-types --no-warnings scripts/eval/report.ts` → 三项核对, 任一不成立退出 1:
  1. report.ts 退出码 0 (`writeReport` 失败时返回 3);
  2. `docs/eval-report.html` 的修改时间不早于开始时间;
  3. 页内「生成于 <ISO 时间>」不早于开始时间。
  时间统一用 node 取 (与 report.ts 的 `toISOString()` 同源), 不依赖各平台 `date` / `stat` 的参数差异。
- `scripts/verify.sh` 在 bench 之后、覆盖总结之前加第 17 步 `eval report: 评测页随 verify 刷新 (report-refresh-check)`。只重画已有的 `eval-out/*.json`, 不重跑评测 (评测要读博客和会话目录, 不适合进每次门禁)。
- 门禁规定每一步都要有「它能失败」的证据: `scripts/verify-gate-evidence.ts` 加一条 `eval-report` (mustMention `report-refresh-check`), 证据写在 `docs/capture-audit.md` 末尾新节 (两种坏法都退出 1, 见下表)。

## 证明

| 命令 | 退出码 | 原始输出前三行 |
|---|---|---|
| `grep -o '生成于 [0-9T:.-]*' docs/eval-report.html; bash scripts/eval/report-refresh-check.sh; grep -o '生成于 [0-9T:.-]*' docs/eval-report.html` | 0 | `生成于 2026-11-01T12:27:43.381` (跑前)<br>`评测页已重生成: /workspace/work/hxm/docs/eval-report.html`<br>`[report-refresh-check] OK: docs/eval-report.html 已刷新 (生成于 2026-11-01T12:28:14.438, 开始 2026-11-01T12:28:13Z)`; 跑后第 4 行 `生成于 2026-11-01T12:28:14.438` |
| 坏法 1: 页面路径占成目录后跑同一脚本 | 1 | `评测页生成失败 (不影响评测结果): Error: EISDIR: illegal operation on a directory, open '…/docs/eval-report.html'`<br>`[report-refresh-check] FAILED: report.ts 退出码 3` (只有两行) |
| 坏法 2: report.ts 换成只写 `生成于 2020-01-01T00:00:00.000Z` 的桩 | 1 | `[report-refresh-check] FAILED: 页内生成时间 '2020-01-01T00:00:00.000' 早于开始 2026-11-01T12:27:44` (只有一行) |
| `node --experimental-strip-types --no-warnings scripts/verify-gate-evidence.ts` | 0 | `verify-gate-evidence: 17 步门禁的证据账`<br>`  [OK]   notes:v2            删除类型声明反向引用时本地退出 1, CI 保留同一诊断并退出 0`<br>`  [OK]   build               tsc 报错即红 (多次)` (末行 `verify-gate-evidence: 每一步都有证据`; verify.sh 的 `step "` 数 = 17 = 清单条数) |
| `bash -n scripts/verify.sh` | 0 | (无输出: 语法通过) |

## 整条 verify 的一条命令

```bash
bash scripts/verify.sh; echo "exit=$?"; grep -o '生成于 [0-9T:.-]*' docs/eval-report.html
```

预期: 倒数第二段打印 `[verify] eval report: 评测页随 verify 刷新 (report-refresh-check)` 和 `[report-refresh-check] OK: …`, 覆盖总结里多一行 `ok: eval report…`, `exit=0`, 最后一行的生成时间是这次 verify 的时间。

**这条整跑本轮没有跑**: 镜像里没有 `node_modules` (第一步 `pnpm run build` 就会失败), 所以上表证明的是这一步本身和门禁登记, 不是整条 verify 的退出码。请在原机上跑上面这条命令; 若 17 步里任何一步红, 退出 1, 页面那一步不会执行到 (verify.sh 遇错即退), 这是有意的: 门禁没过时不刷新页面。

## 改动文件

- `scripts/eval/report-refresh-check.sh` (新)
- `scripts/verify.sh` (+1 步)
- `scripts/verify-gate-evidence.ts` (+1 条证据)
- `docs/capture-audit.md` (末尾 +1 节)

`verify-docs.ts` 在镜像上报 27 处「引用不存在」, 改动前后同为 27 (都指向 `dist/` 或 `.tmp/bench/` 下镜像没有的文件), 本轮没有新增。
