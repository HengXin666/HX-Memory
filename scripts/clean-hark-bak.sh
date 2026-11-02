#!/usr/bin/env bash
# 删除文件写入通道在覆盖时留下的 .hark-bak/ 备份目录 (通道服务端行为, 通道本身不提供 DELETE)。
# 在仓库根目录本机执行: bash scripts/clean-hark-bak.sh        先列出
#                      bash scripts/clean-hark-bak.sh --yes  真删
set -euo pipefail
cd "$(dirname "$0")/.."
mapfile -t dirs < <(find . -type d -name .hark-bak -not -path './node_modules/*')
printf '%s\n' "${dirs[@]:-}"
echo "共 ${#dirs[@]} 个 .hark-bak 目录"
[[ "${1:-}" == "--yes" ]] && { for d in "${dirs[@]}"; do rm -rf -- "$d"; done; echo "已删除"; }
