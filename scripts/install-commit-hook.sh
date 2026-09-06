#!/usr/bin/env bash
# Opt-in Git commit-msg hook installer (house convention: default OFF, only on explicit request).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FORCE=0
[[ "${1:-}" = "--force" ]] && FORCE=1
HOOK="$(git -C "$ROOT" rev-parse --git-path hooks/commit-msg)"
if [[ -e "$HOOK" ]] && [[ $FORCE = 0 ]] && ! grep -q "hx-memory managed commit-msg hook" "$HOOK"; then
  echo "[hx-memory] existing commit-msg hook found; use --force to replace" >&2
  exit 1
fi
cat > "$HOOK" <<'HOOKEOF'
#!/usr/bin/env bash
# hx-memory managed commit-msg hook: enforce [type] subject
set -uo pipefail
MSG_FILE="${1:-}"
[[ -n "$MSG_FILE" && -f "$MSG_FILE" ]] || { echo "[hx-memory] no msg file" >&2; exit 1; }
first_line="$(awk '/^[[:space:]]*(#|$)/{next} {sub(/[[:space:]]+$/, ""); print; exit}' "$MSG_FILE")"
allowed="${HX_COMMIT_TYPES:-feat fix docs style refactor perf test build ci chore revert release deps security}"
pattern_types="$(printf '%s\n' "$allowed" | tr ',[:space:]' '\n' | sed '/^$/d' | sed 's/[][\\.^$*+?{}()|]/\\&/g' | paste -sd'|' -)"
if [[ -z "$first_line" ]]; then
  echo "[hx-memory] Empty commit message. Expected: [feat] subject" >&2; exit 1
fi
if [[ "$first_line" =~ ^\[($pattern_types)\][[:space:]][^[:space:]].* ]]; then
  exit 0
fi
cat >&2 <<EOF
[hx-memory] Invalid commit message:
  $first_line

Expected: [type] subject
Allowed types: $allowed
Examples:
  [feat] add kernel ports
  [fix] handle empty hook input
Fix: git commit -m "[feat] describe the change"
EOF
exit 1
HOOKEOF
chmod 755 "$HOOK"
echo "[hx-memory] commit-msg hook installed at $HOOK"
