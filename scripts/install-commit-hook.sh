#!/usr/bin/env bash
# Git hooks installer (house convention: opt-in; 用户明确要求时装)。
#
# 装两个 hook, 内容都来自 .agents/hooks/ (单一来源, 便于 review 与复用):
#   commit-msg — 提交信息必须是 [type] subject
#   pre-commit — Agent Note 三条硬约束 (结构 / 格式 / 非平凡改动必须带 Note)
#
# 用法: bash scripts/install-commit-hook.sh [--force]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FORCE=0
[[ "${1:-}" = "--force" ]] && FORCE=1

install_hook() {
  local name="$1" source="$2"
  local hook
  hook="$(git -C "$ROOT" rev-parse --git-path "hooks/$name")"
  if [[ ! -f "$ROOT/$source" ]]; then
    echo "[hx-memory] missing hook source: $source" >&2
    return 1
  fi
  if [[ -e "$hook" ]] && [[ $FORCE = 0 ]] && ! grep -q "hx-memory managed $name hook" "$hook"; then
    echo "[hx-memory] existing $name hook found; use --force to replace" >&2
    return 1
  fi
  {
    echo "#!/usr/bin/env bash"
    echo "# hx-memory managed $name hook (source: $source; reinstall: bash scripts/install-commit-hook.sh --force)"
    # 跳过源文件自带的 shebang, 避免出现两个 shebang。
    tail -n +2 "$ROOT/$source"
  } > "$hook"
  chmod 755 "$hook"
  echo "[hx-memory] $name hook installed at $hook"
}

install_hook commit-msg ".agents/hooks/check_commit_msg.sh"
install_hook pre-commit ".agents/hooks/check_agent_notes.sh"
