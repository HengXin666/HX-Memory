#!/usr/bin/env bash
# Pre-commit: Agent Note 硬约束 (结构 + 格式 + 非平凡改动必须带 Note)。
#
# 为什么放在 pre-commit: 覆盖率这条规则只有"提交时就拦住"才有意义 ——
# 等 CI 拒绝再回来补 Note, 上下文已经凉了。
# 跳过: HX_SKIP_NOTE_GATES=1 git commit ...  (不建议; CI 仍会拦)
set -uo pipefail
ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo "$PWD")"
cd "$ROOT" || exit 0
[[ "${HX_SKIP_NOTE_GATES:-0}" == "1" ]] && exit 0

fail() { echo "[hx-memory] $1" >&2; exit 1; }

node --experimental-strip-types scripts/verify-agent-note-classification.ts || fail "Agent Note 结构校验失败 (见上方)"
node --experimental-strip-types scripts/verify-agent-note-format.ts || fail "Agent Note 格式校验失败 (骨架见 .agents/notes/README.md)"
node --experimental-strip-types scripts/verify-agent-note-coverage.ts --staged || fail "非平凡改动必须带 Agent Note (见上方提示)"
exit 0
