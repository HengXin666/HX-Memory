#!/usr/bin/env bash
# Stop hook: summarize verification result; full output to .git/hx-init/logs.
set -uo pipefail
ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo "$PWD")"
cd "$ROOT" || exit 0
LOG="$(git rev-parse --git-path hx-init/logs 2>/dev/null || echo ".agents/logs")"
mkdir -p "$LOG"
LOG_FILE="$LOG/verify-latest.log"

echo "[verify] running tsc + vitest + agent-note gates (summary only)"
if pnpm exec tsc --noEmit >"$LOG_FILE" 2>&1 && pnpm exec vitest run --passWithNoTests >>"$LOG_FILE" 2>&1; then
  # Agent Note 硬约束也在这里提醒一次: 覆盖率失败是最常见的"忘了写 Note", 越早看到越好。
  if ! node --experimental-strip-types scripts/verify-agent-note-classification.ts >>"$LOG_FILE" 2>&1 \
    || ! node --experimental-strip-types scripts/verify-agent-note-format.ts >>"$LOG_FILE" 2>&1 \
    || ! node --experimental-strip-types scripts/verify-agent-note-coverage.ts >>"$LOG_FILE" 2>&1; then
    echo "[verify] 注意: Agent Note gate 未通过 (见下方; 见 .agents/notes/README.md)" >&2
    grep -E 'verify-agent-note|非平凡文件|要求:' "$LOG_FILE" | tail -8 >&2
    exit 0
  fi
  echo "[verify] OK: typecheck + tests + agent-note gates passed"
  exit 0
fi
echo "[verify] FAILED: see $LOG_FILE (last 20 lines):" >&2
tail -20 "$LOG_FILE" >&2
exit 0
