#!/usr/bin/env bash
# scripts/smoke-dsh.sh — 真机 DSH 行为门禁 (不是"能启动"就算过)。
#
# 断言清单 (每一条都对应一个真实踩过的坑):
#   1. 插件组在 profile 里组合成功 (patch 生效);
#   2. patch 不隔离 hxMemory (隔离会让宿主 gateway 看不到服务 → RPC 全 404);
#   3. runtime/client 两个 fiber 都 active (不是"加载失败但进程还活着");
#   4. /api/hxMemory/* 业务结果 {ok:true} (channel/endpoint/args 约定正确);
#   5. runGeneralization 触发点存在且能跑, 且返回**漏斗报告** (considered/clusters/proposed/
#      usedLlm/tookMs) —— 面板状态条据此解释"为什么 0 条"; generalizationStatus 可用;
#   6. saveBindings → listBindings 真往返 (bindingStore 真的挂上了);
#   7. 设置命名空间真的注册到宿主 (installSection/register 双路径 + 双传输形态);
#   8. 绑定真的落盘到 bindings.json (truth-in-files);
#   9. 客户端 bundle 注册的模块 id == boot manifest 行 id == 包名;
#  10. normalizeMemory 返回**干跑报告**且真的挂上了 (主动整理入口), contradictions 可列矛盾。
#
# 版本兼容: 0.1.1 的 /api 无认证; 0.1.2+ 要求浏览器会话 cookie (URL 带 ?token=,
# 先访问一次 / 换取 authority 绑定的签名 cookie)。全部 HTTP 断言在 Node 侧
# (scripts/smoke-dsh-http.mjs), 本脚本只负责: 装插件 → 校验组合 → 起宿主 → 取 URL → 调 Node。
#
# 用法: bash scripts/smoke-dsh.sh [已构建包目录, 默认仓库根]
# 需要: node >= 22.5, curl, 可用的 dsh (${DSH_BIN:-dsh}), 网络 (安装 profile 依赖)。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PKG="${1:-$ROOT}"
DSH_BIN="${DSH_BIN:-dsh}"

fail() { echo "[smoke] FAIL: $*" >&2; exit 1; }
ok() { echo "[smoke] ok: $*"; }

command -v "$DSH_BIN" >/dev/null 2>&1 || fail "dsh not found ($DSH_BIN)"
[ -f "$PKG/package.json" ] || fail "no package.json under $PKG"
[ -f "$PKG/dist/adapters/dsh/index.js" ] || fail "runtime build missing: run pnpm run build"
[ -f "$PKG/dist/dsh/client.js" ] || fail "client bundle missing: run pnpm run build:client"

# 用 fs 读而不是 require: require 对相对路径 ($1 可能是 ./pkg) 解析失败。
PKG_NAME="$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).name)' "$PKG/package.json")"
[ -n "$PKG_NAME" ] || fail "cannot read package name from $PKG/package.json"
echo "[smoke] package: $PKG_NAME ($PKG)"

SMOKE_HOME="$(mktemp -d -t hxmem-smoke-XXXXXX)"
export DSH_HOME="$SMOKE_HOME"
LOG="$SMOKE_HOME/dsh-web.log"
PID=""
cleanup() {
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null || true
    wait "$PID" 2>/dev/null || true
  fi
  rm -rf "$SMOKE_HOME"
}
trap cleanup EXIT

echo "[smoke] installing plugin into an isolated DSH_HOME"
"$DSH_BIN" plugin --profile web add "file:$PKG" >/dev/null 2>&1 || fail "dsh plugin add failed"

TREE="$("$DSH_BIN" --profile web --dump-config 2>&1 || true)"
echo "$TREE" | grep -q "id: hx-memory$" || fail "plugin group missing from composed profile"
# 注意: dump 里包名带 YAML 引号 (name: '@scope/pkg'), 且 provenance 注释行 "# == @scope/pkg"
# 也会被"以包名结尾"的宽松模式命中 —— 必须精确匹配 name 行。
echo "$TREE" | grep -qF "name: '$PKG_NAME/dsh'" || fail "runtime entry missing from composed profile"
echo "$TREE" | grep -qF "name: '$PKG_NAME'" || fail "client entry missing from composed profile"
if echo "$TREE" | grep -A 12 "id: hx-memory$" | grep -q "isolate"; then
  fail "hx-memory group is isolated — the host Typert gateway cannot see the service"
fi
ok "profile composes without isolate"

echo "[smoke] booting web host"
( "$DSH_BIN" web --port 0 --no-open > "$LOG" 2>&1 ) &
PID=$!

TOKEN_URL=""
for _ in $(seq 1 60); do
  # 0.1.2+ 打印的 URL 带 ?token= (进程启动令牌); 0.1.1 只有裸 origin
  TOKEN_URL="$(grep -oE 'http://127\.[0-9]+\.[0-9]+\.[0-9]+:[0-9]+[^ ]*' "$LOG" 2>/dev/null | head -1 || true)"
  [ -n "$TOKEN_URL" ] && break
  kill -0 "$PID" 2>/dev/null || { cat "$LOG" >&2; fail "web host exited during boot"; }
  sleep 1
done
[ -n "$TOKEN_URL" ] || { cat "$LOG" >&2; fail "web host did not report a URL"; }
echo "[smoke] host: ${TOKEN_URL%%\?*}"

# 全部 HTTP/RPC 断言在 Node 侧 (cookie 认证、双传输形态、信封与业务结果校验)
node "$ROOT/scripts/smoke-dsh-http.mjs" "$TOKEN_URL" "$PKG_NAME" "$SMOKE_HOME" || fail "HTTP 断言失败"

echo "[smoke] PASS"
