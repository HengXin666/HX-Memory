#!/usr/bin/env bash
set -uo pipefail
ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo "$PWD")"
cd "$ROOT" || exit 0
# Report emoji-like symbols in text files written this turn (house style: no emojis in docs).
LOG_DIR="$(git rev-parse --git-path hx-init/logs 2>/dev/null || echo ".agents/logs")"
mkdir -p "$LOG_DIR" 2>/dev/null || true
LOG_FILE="$LOG_DIR/emoji-latest.log"
FOUND=0
while IFS= read -r f; do
  [[ -z "$f" ]] && continue
  case "$f" in
    *.ts|*.tsx|*.md|*.json|*.yml|*.yaml)
      if grep -qE '✅|❌|🚫|⭐|🔥|💡|📝|🎯|⚠️|❗|❓|✨|🔴|📋|🔧|📌|📊|🏗️|👍' "$f" 2>/dev/null; then
        FOUND=$((FOUND+1))
        echo "$f" >>"$LOG_FILE" 2>/dev/null || true
      fi
      ;;
  esac
done < <(cat | grep -oE '"file_path" *: *"[^"]+"|\*\*\* (Add|Update) File: [^*]+' 2>/dev/null | grep -oE '"[^"]+"$|: [^*]+$' | tr -d '"' | sed 's/^: //')
if [[ $FOUND -gt 0 ]]; then
  echo "[hooks] emoji-like symbols in $FOUND file(s); log: $LOG_FILE (docs should use text not emoji)" >&2
fi
exit 0
