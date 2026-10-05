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
#  10. normalizeMemory 返回**干跑报告**且真的挂上了 (主动整理入口), contradictions 可列矛盾;
#  11. flaggedMemories 返回数组 (agent 负面标注面: 空数组是正常且期望的)。
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
# `dsh plugin` 是 pnpm 的转发器 (它 spawn 一个 pnpm 去管 profile 依赖)。pnpm 不在 PATH 上时
# 它只会失败, 而失败原因会被下面的重定向吞掉 —— 先自己检查, 把"缺什么"直接说出来。
# 实测: 本机 pnpm 只在它自己的安装目录里 (不在 PATH), 于是本脚本静默死在第一步。
command -v pnpm >/dev/null 2>&1 \
  || fail "pnpm not found on PATH — dsh plugin needs it; e.g. export PATH=\"\$(dirname \"\$(ls -d \"\$HOME\"/.local/share/pnpm/.tools/pnpm/*/bin/pnpm 2>/dev/null | tail -1)\")/:\$PATH\""
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

# ── 播种: 让"注入预览"的断言真的有事可断言 ──────────────────────────────────
# 为什么必须播种 (2026-09-18): 隔离 DSH_HOME 是**空库**, 于是 alwaysOnPreview 返回
# picked=[] / blocked=[] —— 那条断言只验证了信封形状, **自洽性断言 (picked 与 blocked
# 不相交) 在空集上恒真**, 属空转。播种一条已确认规则后, 该断言才真的在跑。
#
# 为什么用 CLI 的 import (而不是直接写 Markdown 文件): 规则需要 confirmedBy/confirmedAt
# 才会进保底通道, 而这两个字段的写入路径由领域层管 —— 手写 frontmatter 容易漏掉字段名约定。
# 走 import 走的是**产品自己的写入路径**, 与真实使用一致。
MEM_ROOT="$SMOKE_HOME/hx-memory"
mkdir -p "$MEM_ROOT"
SEED_RULE_ID="mseed00000000smoke"
node "$PKG/dist/adapters/codex/cli.js" import --root "$MEM_ROOT" <<SEED_EOF >/dev/null
{"id":"$SEED_RULE_ID","kind":"rule","content":"冒烟测试规则: 此条由 smoke 播种, 用于让注入预览的自洽性断言不再是空转","source":"smoke:seed","scope":"global","confirmedBy":"smoke","confirmedAt":"2026-01-01T00:00:00.000Z","ts":{"validAt":"2026-01-01T00:00:00.000Z","assertedAt":"2026-01-01T00:00:00.000Z"},"status":"active"}
SEED_EOF
# 播种必须**真的成功**才继续 —— 否则下面的断言又会退回空转, 而那是静默的。
if ! node "$PKG/dist/adapters/codex/cli.js" rules --root "$MEM_ROOT" 2>/dev/null | grep -q "$SEED_RULE_ID"; then
  fail "seed rule not visible to CLI (播种失败: 注入预览的断言会退回空转)"
fi
ok "已播种一条已确认规则 (让注入预览的断言有事可断言)"

# ── 播种一对**互相矛盾**的条目: 让 contradictions 端点的断言也能验到元素形状 ──────
#
# 为什么必须播种 (2026-09-18, §475): contradictions 此前在冒烟环境里**返回空数组**,
# 于是那条断言只证明"端点挂上了 + 是数组" —— **不证明元素形状正确** (该限界当时写在
# smoke-dsh-http.mjs 的注释里)。而"矛盾可被发现"是 keep-both 那条保守设计的**唯一出口**
# (gateway.ts:268 的注释: "此前没有任何入口能列出这些矛盾 … 等于永久悬空")。
#
# 所以这里播种两条**数字不同**的同 kind 条目 + 双向 contradicts 边 ⇒ 端点必须有东西可列。
SEED_CONTRA_A="mseed0000000contra"
SEED_CONTRA_B="mseed0000000contbz"
node "$PKG/dist/adapters/codex/cli.js" import --root "$MEM_ROOT" <<CONTRA_EOF >/dev/null
{"id":"$SEED_CONTRA_A","kind":"fact","content":"冒烟测试矛盾条目 A: 缓存过期设为 60 秒","source":"smoke:seed","scope":"agent","ts":{"validAt":"2026-01-01T00:00:01.000Z","assertedAt":"2026-01-01T00:00:01.000Z"},"status":"active","relations":[{"type":"contradicts","toId":"$SEED_CONTRA_B","weight":1}]}
{"id":"$SEED_CONTRA_B","kind":"fact","content":"冒烟测试矛盾条目 B: 缓存过期设为 120 秒","source":"smoke:seed","scope":"agent","ts":{"validAt":"2026-01-01T00:00:02.000Z","assertedAt":"2026-01-01T00:00:02.000Z"},"status":"active","relations":[{"type":"contradicts","toId":"$SEED_CONTRA_A","weight":1}]}
CONTRA_EOF
if ! node "$PKG/dist/adapters/codex/cli.js" rules --root "$MEM_ROOT" >/dev/null 2>&1; then
  fail "播种矛盾条目后 CLI 不可用"
fi
ok "已播种一对互相矛盾的条目 (让 contradictions 的断言真的在跑)"

# ── 播种一组同主题 lesson: 让 reviewQueue / runGeneralization 的读数不再是"空库下的 0" ──
#
# 为什么必须播种 (2026-09-18, §478): `runGeneralization` 的 `proposed` 在空库下恒为 **0**
# (它只对 lesson/pattern/decision 聚簇, 而冒烟库里一条都没有) ⇒ 那条断言只证明"报告有字段",
# **不证明漏斗真的能产出提议**; `reviewQueue` 同理 (恒空数组)。
#
# 主题词取自 THEME_DICT 的 `memory` 桶 ("记忆"/"注入"/"召回") ⇒ 三条会聚成一簇。
for i in 1 2 3; do
  node "$PKG/dist/adapters/codex/cli.js" import --root "$MEM_ROOT" <<LESSON_EOF >/dev/null
{"id":"mseed00000lesson$i","kind":"lesson","content":"冒烟测试经验 $i: 记忆注入的召回阈值需要按语料规模重新标定, 否则注入的条目会偏多。","source":"smoke:seed","scope":"agent","ts":{"validAt":"2026-01-01T00:00:0$i.000Z","assertedAt":"2026-01-01T00:00:0$i.000Z"},"status":"active"}
LESSON_EOF
done
ok "已播种 3 条同主题 lesson (让泛化漏斗与审核队列的读数不再恒为 0)"

echo "[smoke] installing plugin into an isolated DSH_HOME"
# 不把输出丢进 /dev/null: 安装失败的原因 (版本冲突、pnpm 报错、tarball 问题) 正是排查所需。
if ! ADD_OUT="$("$DSH_BIN" plugin --profile web add "file:$PKG" 2>&1)"; then
  echo "$ADD_OUT" >&2
  fail "dsh plugin add failed"
fi

TREE="$("$DSH_BIN" --profile web --dump-config 2>&1 || true)"
# 组条目 id = hx-memory-group; **runtime 条目 id 必须正好是 `hx-memory`** ——
# 0.1.7 起它就是设置命名空间 (见 dsh/cordis.patch.yml 顶部说明), 也是下面
# settings/describe 断言查的那个 ns。这两条 id 各自唯一, 否则设置条目会被宿主整批丢弃。
echo "$TREE" | grep -q "id: hx-memory-group$" || fail "plugin group missing from composed profile"
echo "$TREE" | grep -qE "^ +- id: hx-memory$" || fail "runtime entry id must be exactly 'hx-memory' (it is the settings namespace on 0.1.7+)"
# 注意: dump 里包名带 YAML 引号 (name: '@scope/pkg'), 且 provenance 注释行 "# == @scope/pkg"
# 也会被"以包名结尾"的宽松模式命中 —— 必须精确匹配 name 行。
echo "$TREE" | grep -qF "name: '$PKG_NAME/dsh'" || fail "runtime entry missing from composed profile"
echo "$TREE" | grep -qF "name: '$PKG_NAME'" || fail "client entry missing from composed profile"
if echo "$TREE" | grep -A 14 "id: hx-memory-group$" | grep -q "isolate"; then
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
