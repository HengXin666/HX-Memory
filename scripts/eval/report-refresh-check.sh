#!/usr/bin/env bash
# scripts/eval/report-refresh-check.sh — verify.sh 的「评测页随门禁刷新」一步 (2026-11-01)。
#
# 做什么: 记下开始时间 → 跑 scripts/eval/report.ts (读 eval-out/*.json, 写 docs/eval-report.html) →
#         核对三件事, 任何一件不成立就退出 1:
#           1. report.ts 退出码为 0 (writeReport 失败时它返回 3);
#           2. docs/eval-report.html 存在且修改时间不早于开始时间 (真的重写了, 不是旧文件);
#           3. 页内「生成于 <ISO 时间>」不早于开始时间 (内容是这次渲染的)。
# 为什么单独成脚本: verify.sh 每一步都要有「它能失败」的证据 (scripts/verify-gate-evidence.ts),
#         这一步的失败证据见 docs/capture-audit.md「report-refresh-check」一节。
# 用法: bash scripts/eval/report-refresh-check.sh     退出码: 0 已刷新; 1 未刷新或渲染失败。
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
PAGE="docs/eval-report.html"
# 时间用 node 取 (与 report.ts 的 toISOString 同一来源, 不依赖各平台 date 的参数差异)
START_EPOCH=$(node -e 'console.log(Math.floor(Date.now() / 1000))')
START_ISO=$(node -e 'console.log(new Date().toISOString().slice(0, 19))')
node --experimental-strip-types --no-warnings scripts/eval/report.ts
rc=$?
if [[ $rc -ne 0 ]]; then
  echo "[report-refresh-check] FAILED: report.ts 退出码 $rc" >&2
  exit 1
fi
if [[ ! -f "$PAGE" ]]; then
  echo "[report-refresh-check] FAILED: $PAGE 不存在" >&2
  exit 1
fi
MTIME=$(node -e 'console.log(Math.floor(require("node:fs").statSync(process.argv[1]).mtimeMs / 1000))' "$PAGE")
if (( MTIME < START_EPOCH )); then
  echo "[report-refresh-check] FAILED: $PAGE 修改时间 $MTIME 早于开始 $START_EPOCH (没有重写)" >&2
  exit 1
fi
GEN=$(grep -o '生成于 [0-9T:.-]*' "$PAGE" | head -1 | sed 's/生成于 //')
if [[ -z "$GEN" || "${GEN:0:19}" < "$START_ISO" ]]; then  # ISO 时间同格式, 字典序即时间序
  echo "[report-refresh-check] FAILED: 页内生成时间 '$GEN' 早于开始 $START_ISO" >&2
  exit 1
fi
echo "[report-refresh-check] OK: $PAGE 已刷新 (生成于 $GEN, 开始 ${START_ISO}Z)"
