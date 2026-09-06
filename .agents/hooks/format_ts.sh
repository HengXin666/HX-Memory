#!/usr/bin/env bash
# PostToolUse formatter for TS/JSON/MD files touched this turn (best-effort, never fails the turn).
set -uo pipefail
ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo "$PWD")"
cd "$ROOT" || exit 0

INPUT="$(cat || true)"
FILES="$(
  printf '%s' "$INPUT" | tr '{' '\n' | grep -oE '"(file_path|filepath|path)"[[:space:]]*:[[:space:]]*"[^"]+"' | sed -E 's/^"[^"]+"[[:space:]]*:[[:space:]]*"//; s/"$//'
)"
[[ -z "$FILES" ]] && exit 0

while IFS= read -r f; do
  [[ -z "$f" ]] && continue
  case "$f" in
    *.ts|*.tsx|*.json|*.md|*.yml|*.yaml)
      if [[ -f "$f" ]]; then pnpm exec prettier --write "$f" >/dev/null 2>&1 || true; fi
      ;;
  esac
done <<< "$FILES"
exit 0
