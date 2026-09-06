#!/usr/bin/env bash
# Stop hook: summarize verification result; full output to .git/hx-init/logs.
set -uo pipefail
ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo "$PWD")"
cd "$ROOT" || exit 0
LOG="$(git rev-parse --git-path hx-init/logs 2>/dev/null || echo ".agents/logs")"
mkdir -p "$LOG"
LOG_FILE="$LOG/verify-latest.log"

echo "[verify] running tsc + vitest (summary only)"
if pnpm exec tsc --noEmit >"$LOG_FILE" 2>&1 && pnpm exec vitest run --passWithNoTests >>"$LOG_FILE" 2>&1; then
  echo "[verify] OK: typecheck + tests passed"
  exit 0
fi
echo "[verify] FAILED: see $LOG_FILE (last 20 lines):" >&2
tail -20 "$LOG_FILE" >&2
exit 0
