#!/usr/bin/env bash
# scripts/capture-repair.sh — 把 HX-Memory 重新选入 DSH web profile 的组合包列表 (根因见 COLLECT-BROKEN.md)。
#
# 做三件事, 每步失败即停:
#   1. 备份 ~/.dsh/profiles/<profile>/package.json → package.json.bak-capture-repair-<时间戳>
#   2. 若 dsh.profile.bundles 里没有 @hengxin666/hx-memory 就追加到末尾 (= 插件页「开启」的语义); 已在则不改 (幂等)
#   3. pnpm run build && pnpm run build:client  (dist 与 src 对齐; 插件从 dist 加载)
# 之后需要**重启 DSH** 才生效 (组合包列表在启动/重新组合时读取)。
#
# 用法: bash scripts/capture-repair.sh [--profile web] [--no-build] [--check]
#   --check  只报告状态, 不改任何东西 (退出码: 0 = 已选入, 3 = 未选入)
set -euo pipefail
PROFILE=web
BUILD=1
CHECK=0
while [ $# -gt 0 ]; do
  case "$1" in
    --profile) PROFILE="$2"; shift 2 ;;
    --no-build) BUILD=0; shift ;;
    --check) CHECK=1; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
REPO="$(cd "$(dirname "$0")/.." && pwd)"
PKG="${DSH_HOME:-$HOME/.dsh}/profiles/$PROFILE/package.json"
NAME="@hengxin666/hx-memory"
[ -f "$PKG" ] || { echo "profile 清单不存在: $PKG" >&2; exit 2; }

state() {
  node -e '
    const p = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const b = (p.dsh && p.dsh.profile && p.dsh.profile.bundles) || [];
    const d = Object.assign({}, p.dependencies || {}, p.devDependencies || {});
    console.log(JSON.stringify({ installed: process.argv[2] in d, spec: d[process.argv[2]] || null, selected: b.includes(process.argv[2]), bundles: b.length }));
  ' "$PKG" "$NAME"
}

echo "[1/3] 现状: $(state)"
if [ "$CHECK" = 1 ]; then
  state | grep -q '"selected":true' && exit 0 || exit 3
fi

if state | grep -q '"selected":true'; then
  echo "[2/3] 已在 dsh.profile.bundles 里, 不改"
else
  state | grep -q '"installed":true' || { echo "依赖里也没有 $NAME, 先装: cd $REPO && dsh plugin --profile $PROFILE add ." >&2; exit 4; }
  BAK="$PKG.bak-capture-repair-$(date +%Y%m%d-%H%M%S)"
  cp -p "$PKG" "$BAK"
  echo "[2/3] 已备份 → $BAK"
  node -e '
    const fs = require("fs");
    const f = process.argv[1], name = process.argv[2];
    const p = JSON.parse(fs.readFileSync(f, "utf8"));
    p.dsh = p.dsh || {}; p.dsh.profile = p.dsh.profile || {};
    const b = p.dsh.profile.bundles = p.dsh.profile.bundles || [];
    if (!b.includes(name)) b.push(name);
    const tmp = f + ".tmp-" + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(p, null, 2) + "\n");
    fs.renameSync(tmp, f);
  ' "$PKG" "$NAME"
  echo "      追加后: $(state)"
fi

if [ "$BUILD" = 1 ]; then
  echo "[3/3] 构建 dist"
  (cd "$REPO" && pnpm run build && pnpm run build:client)
else
  echo "[3/3] 跳过构建 (--no-build)"
fi
echo "完成。重启 DSH 后开一轮对话, 应出现 ~/.dsh/hx-memory/capture/$(date -u +%F).jsonl"
