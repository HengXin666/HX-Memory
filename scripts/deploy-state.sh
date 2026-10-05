#!/usr/bin/env bash
# scripts/deploy-state.sh — 部署状态: dist 是否最新 + 宿主是否加载了它。
#
# 为什么需要它 (2026-09-18): 本仓库是**宿主插件** —— `dist` 重建后,
# **正在运行的宿主进程不会自动重新加载**。于是会出现:
#   · `git status` 干净、`pnpm run verify` 全绿、`dist` 是最新的;
#   · 但你在面板上看到的行为**还是旧代码的**。
# 这种"代码已改而行为未变"很容易被误读成"改动没生效/有 bug"。
#
# 判据: 比较 dist 的 mtime 与宿主进程的**真实启动时刻**。
#
# ⚠ 时间来源踩过两个坑 (都实测过):
#   1. `ps -o lstart` 在中文 locale 下输出本地化日期 ("六 9月 19 11:35:07 2026"),
#      而 `date -d` **解析不了** ⇒ 脚本把所有进程都判成了最新 (假阴性)。
#   2. 改用 `stat -c %Z /proc/<pid>` 也不行 —— 那是**目录 ctime**,
#      实测比真实启动晚 1 小时 (目录被 touch 过)。
#   正确做法: `/proc/<pid>/stat` 的 `starttime` 字段 + `/proc/uptime` 换算 (无 locale 依赖)。
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# ⚠ **两个产物都要检查** (2026-09-18, §586): 产品有服务端 (tsc) 与客户端 bundle (esbuild)
# 两条独立的构建命令 (`build` / `build:client`)。只检查服务端会让"只跑了一半构建"的情形**报绿**:
#   · `pnpm run build` 成功、`build:client` 没跑 ⇒ 客户端停留在旧 bundle;
#   · 而宿主的插件包是**整个 dist 目录** ⇒ 面板会加载旧客户端代码。
# 判据取**两者较新者** —— 那才是"这次构建完成于何时"。
DIST="$ROOT/dist/adapters/dsh/index.js"
CLIENT_DIR="$ROOT/dist/adapters/dsh/client"
[ -f "$DIST" ] || { echo "no dist build yet — run: pnpm run build && pnpm run build:client" >&2; exit 1; }
[ -d "$CLIENT_DIR" ] || { echo "no client bundle yet — run: pnpm run build:client" >&2; exit 1; }

DIST_EPOCH=$(stat -c %Y "$DIST")
CLIENT_EPOCH=$(find "$CLIENT_DIR" -name '*.js' -printf '%T@\n' 2>/dev/null | sort -n | tail -1 | cut -d. -f1)
CLIENT_EPOCH=${CLIENT_EPOCH:-0}
NEWEST=$DIST_EPOCH
[ "$CLIENT_EPOCH" -gt "$NEWEST" ] && NEWEST=$CLIENT_EPOCH
echo "=== 构建产物 ==="
echo "  server: $(date -d "@$DIST_EPOCH" '+%Y-%m-%d %H:%M:%S')"
echo "  client: $(date -d "@$CLIENT_EPOCH" '+%Y-%m-%d %H:%M:%S')"
# 两者相差超过 5 分钟 ⇒ 有一半构建是**单独漏跑**的 (正常同批构建只差秒级)。
if [ "$CLIENT_EPOCH" -gt 0 ]; then
  DIFF=$((DIST_EPOCH - CLIENT_EPOCH))
  [ "$DIFF" -lt 0 ] && DIFF=$((-DIFF))
  if [ "$DIFF" -gt 300 ]; then
    echo "  ⚠ **两侧构建相差 ${DIFF} 秒 ⇒ 有一半是单独漏跑的** (重跑: 两者都构建)" >&2
    STALE_BUILD=1
  fi
fi
DIST_EPOCH=$NEWEST

echo "=== 宿主进程 ==="
STALE=0
FOUND=0
for pid in $(pgrep -f "dsh web" 2>/dev/null | sort -u); do
  cmd=$(ps -o cmd= -p "$pid" 2>/dev/null) || continue
  case "$cmd" in *"dsh web"*) ;; *) continue ;; esac
  FOUND=1
  START=$(python3 -c "
import os, time, sys
pid = sys.argv[1]
try:
    with open('/proc/%s/stat' % pid) as f:
        parts = f.read().rsplit(')', 1)[1].split()
    ticks = int(parts[19]); hz = os.sysconf('SC_CLK_TCK')
    with open('/proc/uptime') as f:
        up = float(f.read().split()[0])
    print(int(time.time() - up + ticks / hz))
except Exception:
    print(0)
" "$pid" 2>/dev/null)
  [ -z "$START" ] || [ "$START" -eq 0 ] && { echo "  pid $pid (读不到启动时间, 跳过)"; continue; }
  echo "  pid $pid 启动于 $(date -d "@$START" '+%Y-%m-%d %H:%M:%S')"
  if [ "$START" -lt "$DIST_EPOCH" ]; then
    echo "    ⇒ **早于构建 ⇒ 加载的是旧模块** (重启宿主后改动才生效)" >&2
    STALE=1
  else
    echo "    ⇒ 晚于构建 ⇒ 加载的是最新产物 ✓"
  fi
done
[ "$FOUND" -eq 1 ] || echo "  (未发现运行中的 dsh web 进程)"
[ "$STALE" -eq 0 ] || exit 2
