#!/usr/bin/env bash
# scripts/smoke-dsh.sh — 真机 DSH 行为门禁 (不是"能启动"就算过)。
#
# 断言清单 (每一条都对应一个真实踩过的坑):
#   1. 插件组在 profile 里组合成功 (patch 生效);
#   2. patch 不隔离 hxMemory (隔离会让宿主 gateway 看不到服务 → RPC 全 404);
#   3. runtime/client 两个 fiber 都 active (不是"加载失败但进程还活着");
#   4. /api/hxMemory/* 真的 200 且返回 {ok:true} (channel/endpoint/args 约定正确);
#   5. runGeneralization 触发点存在且能跑 (推广闭环不是空转);
#   6. saveBindings/listBindings 往返成功 (bindingStore 真的挂上了);
#   7. 客户端 bundle 注册的模块 id == boot manifest 的行 id == 包名 (面板才挂得上)。
#
# 用法: bash scripts/smoke-dsh.sh [已构建包目录, 默认仓库根]
# 需要: node >= 22.5, curl, 可用的 dsh ($DSH_BIN 覆盖), 网络 (安装 profile 依赖)。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PKG="${1:-$ROOT}"
DSH_BIN="${DSH_BIN:-dsh}"
PORT_LINE=""

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
# 注意: dump 里包名带 YAML 引号 (name: '@scope/pkg'), 行尾锚点会撞上那个引号;
# 而且 provenance 注释行 "# == @scope/pkg" 也会被"以包名结尾"的宽松模式命中 —— 必须精确匹配 name 行。
echo "$TREE" | grep -qF "name: '$PKG_NAME/dsh'" || fail "runtime entry missing from composed profile"
echo "$TREE" | grep -qF "name: '$PKG_NAME'" || fail "client entry missing from composed profile"
if echo "$TREE" | grep -A 12 "id: hx-memory$" | grep -q "isolate"; then
  fail "hx-memory group is isolated — the host Typert gateway cannot see the service"
fi
ok "profile composes without isolate"

echo "[smoke] booting web host"
( "$DSH_BIN" web --port 0 --no-open > "$LOG" 2>&1 ) &
PID=$!

URL=""
for _ in $(seq 1 60); do
  URL="$(grep -oE 'http://127\.0\.0\.1:[0-9]+' "$LOG" 2>/dev/null | head -1 || true)"
  [ -n "$URL" ] && break
  kill -0 "$PID" 2>/dev/null || { cat "$LOG" >&2; fail "web host exited during boot"; }
  sleep 1
done
[ -n "$URL" ] || { cat "$LOG" >&2; fail "web host did not report a URL"; }
echo "[smoke] host: $URL"

rpc() { # rpc <method> <args-json>
  local method="$1" args="$2" rpcid
  rpcid="$(node -e 'process.stdout.write(crypto.randomUUID())')"
  curl -sS -m 30 -X POST "$URL/api/$method" \
    -H 'content-type: application/json' \
    -d "{\"type\":\"client-request\",\"rpcId\":\"$rpcid\",\"method\":\"$method\",\"payload\":{\"args\":$args}}"
}

# 3) 两个 fiber 都 active
INV="$(rpc pluginInventory/list '{}')"
echo "$INV" | node -e '
let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  const parsed = JSON.parse(raw);
  const entries = parsed.result?.value?.entries ?? [];
  const wanted = ["hx-memory-runtime", "hx-memory-client"];
  for (const name of wanted) {
    const row = entries.find((e) => e.entryId.endsWith(name));
    if (!row) { console.error("[smoke] missing entry " + name); process.exit(1); }
    if (row.fiberPhase !== "active") { console.error("[smoke] " + name + " fiber=" + row.fiberPhase); process.exit(1); }
  }
})' || fail "plugin fibers are not active"
ok "runtime + client fibers active"

# 4) RPC 约定: 信封必须 ok:true, 且**业务结果**不能是 {ok:false}。
#    宿主对业务失败也返回信封 ok:true (例如 binding store not mounted), 只看信封会假通过。
check_ok() { # check_ok <method> <args-json> <描述>
  local out
  # || true: 让 curl 失败也走到下面的诊断, 而不是被 set -e 直接吞掉
  out="$(rpc "$1" "$2" || true)"
  echo "$out" | node -e '
let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  const parsed = JSON.parse(raw);
  if (parsed.result?.ok !== true) { console.error("[smoke] RPC envelope failed: " + raw.slice(0, 300)); process.exit(1); }
  const value = parsed.result.value;
  if (value !== null && typeof value === "object" && value.ok === false) {
    console.error("[smoke] RPC business failure: " + raw.slice(0, 300));
    process.exit(1);
  }
})' || fail "$3 ($1)"
  ok "$3"
}

check_ok hxMemory/reviewQueue '{"status":"proposed"}' "reviewQueue 200 + ok"
check_ok hxMemory/runGeneralization '{"limit":100}' "runGeneralization 触发点可用"
check_ok hxMemory/listInvocations '{"limit":10}' "listInvocations 可用"
check_ok hxMemory/recentCaptures '{"limit":10}' "recentCaptures 可用"
check_ok hxMemory/listBindings '{}' "listBindings 可用 (bindingStore 已挂载)"
check_ok hxMemory/saveBindings '{"configs":[{"project":"smoke","bindings":[{"id":"cross-rules","query":{"kind":"rule","scope":"global"}}]}]}' "saveBindings 写入成功"

# 真往返: 写进去的绑定必须能读回来 (只断言"调用成功"挡不住 store 未挂载的回归)
LISTED="$(rpc hxMemory/listBindings '{}')"
echo "$LISTED" | node -e '
let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  const parsed = JSON.parse(raw);
  const configs = parsed.result?.value ?? [];
  const hit = Array.isArray(configs) && configs.some((c) => c && c.project === "smoke");
  if (!hit) { console.error("[smoke] bindings round-trip failed: " + raw.slice(0, 300)); process.exit(1); }
})' || fail "saveBindings → listBindings 往返"
ok "saveBindings → listBindings 真往返"

# 5) 设置命名空间真的注册到了宿主 (installSection 的端到端接线; 唯一曾经坏过、此前无真机覆盖的一环)
api_call() { # api_call <method> <payload-json>  —— apiproxy 方法, payload 就是请求体 (不是 {args})
  local method="$1" payload="$2" rpcid
  rpcid="$(node -e 'process.stdout.write(crypto.randomUUID())')"
  curl -sS -m 30 -X POST "$URL/api/$method" \
    -H 'content-type: application/json' \
    -d "{\"type\":\"client-request\",\"rpcId\":\"$rpcid\",\"method\":\"$method\",\"payload\":$payload}"
}
SETTINGS="$(api_call settings.describe '{}' || true)"
echo "$SETTINGS" | node -e '
let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  const parsed = JSON.parse(raw);
  const namespaces = parsed.result?.value?.namespaces ?? [];
  const hit = Array.isArray(namespaces) && namespaces.some((n) => n && n.ns === "hx-memory");
  if (!hit) { console.error("[smoke] settings namespace missing: " + raw.slice(0, 300)); process.exit(1); }
})' || fail "settings.describe 未包含 hx-memory 命名空间"
ok "设置命名空间已注册 (installSection / register 接线可用)"

# 6) truth-in-files: 绑定必须真的落到 $DSH_HOME/hx-memory/bindings.json
BINDINGS_FILE="$SMOKE_HOME/hx-memory/bindings.json"
[ -f "$BINDINGS_FILE" ] || fail "bindings.json not written to $BINDINGS_FILE"
node -e '
const fs = require("node:fs");
const configs = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const hit = Array.isArray(configs) && configs.some((c) => c && c.project === "smoke");
if (!hit) { console.error("[smoke] bindings.json missing smoke project"); process.exit(1); }
' "$BINDINGS_FILE" || fail "bindings.json 内容不对"
ok "绑定已落盘 (truth-in-files)"

# 7) 客户端 bundle 的模块 id 与 boot manifest 行 id 一致
PAGE="$(curl -sS -m 30 "$URL/")"
echo "$PAGE" | grep -q "\"id\":\"$PKG_NAME\"" || fail "boot manifest has no row for $PKG_NAME"
BUNDLE_HEAD="$(curl -sS -m 30 "$URL/plugins/$PKG_NAME/client.js" | head -4)"
echo "$BUNDLE_HEAD" | grep -q "id: \"$PKG_NAME\"" || { echo "$BUNDLE_HEAD" >&2; fail "client bundle registers a different module id"; }
ok "client bundle module id matches the boot graph row"

echo "[smoke] PASS"
