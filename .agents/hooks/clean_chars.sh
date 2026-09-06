#!/usr/bin/env bash
# PostToolUse: strip trailing whitespace / zero-width chars / BOM from touched text files.
set -uo pipefail
ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo "$PWD")"
cd "$ROOT" || exit 0
while IFS= read -r f; do
  [[ -z "$f" ]] && continue
  case "$f" in
    *.ts|*.tsx|*.md|*.json|*.yml|*.yaml)
      sed -i'' -e 's/[ \t]\+$//g' \
        -e $'s/\xe2\x80\x8b//g' \
        -e $'s/\xe2\x80\x8c//g' \
        -e $'s/\xe2\x80\x8d//g' \
        -e $'s/\xef\xbb\xbf//g' "$f" 2>/dev/null || true
      ;;
  esac
done < <(cat | grep -oE '"file_path" *: *"[^"]+"|\*\*\* (Add|Update) File: [^*]+' 2>/dev/null | grep -oE '"[^"]+"$|: [^*]+$' | tr -d '"' | sed 's/^: //')
exit 0
