#!/usr/bin/env bash
# hx-memory commit-msg checker (invoked by .git/hooks/commit-msg when installed).
set -uo pipefail
MSG_FILE="${1:-}"
if [[ -z "$MSG_FILE" || ! -f "$MSG_FILE" ]]; then
  echo "[hx-memory] commit-msg hook requires message file path." >&2; exit 1
fi
first_line="$(awk '/^[[:space:]]*(#|$)/{next} {sub(/[[:space:]]+$/, ""); print; exit}' "$MSG_FILE")"
allowed="${HX_COMMIT_TYPES:-feat fix docs style refactor perf test build ci chore revert release deps security}"
pattern_types="$(printf '%s\n' "$allowed" | tr ',[:space:]' '\n' | sed '/^$/d' | sed 's/[][\\.^$*+?{}()|]/\\&/g' | paste -sd'|' -)"
if [[ -z "$first_line" ]]; then
  echo "[hx-memory] Empty commit message. Expected: [type] subject" >&2; exit 1
fi
if [[ "$first_line" =~ ^\[($pattern_types)\][[:space:]][^[:space:]].* ]]; then
  exit 0
fi
cat >&2 <<EOF
[hx-memory] Invalid commit message:
  $first_line
Expected: [type] subject
Allowed types: $allowed
Fix: git commit -m "[feat] subject"
EOF
exit 1
