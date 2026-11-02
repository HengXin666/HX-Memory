#!/usr/bin/env bash
# scripts/panel-register.sh — 把面板登记进 HX-WebX (默认 http://127.0.0.1:36000), 按 docs/AI-INTEGRATION.md 的流程:
#   ① GET /api/info 确认面板在   ② GET /api/ports/36100 查占用   ③ POST /api/services 注册 (带 workdir + startCommand)
#   ④ 起服务 (POST /api/services/<name>/start, 面板托管进程组)   ⑤ 经 /proxy/<name>/api/health 验收
# 鉴权: Authorization: Bearer $(cat ~/.hxwebx/agent-token)  (HX-WebX guard.ts 的机器凭据)。
set -Eeuo pipefail
cd "$(dirname "$0")/.."
WEBX="${HX_WEBX_URL:-http://127.0.0.1:36000}"
NAME="${HX_PANEL_NAME:-hx-memory-panel}"
PORT="${HX_PANEL_PORT:-36100}"
TOKEN_FILE="${HX_WEBX_TOKEN_FILE:-$HOME/.hxwebx/agent-token}"
AUTH=(-H "Authorization: Bearer $(cat "${TOKEN_FILE}")")
J=(-H "Content-Type: application/json")

echo "① info";  curl -fsS "${AUTH[@]}" "${WEBX}/api/info"; echo
echo "② port";  PORTINFO="$(curl -fsS "${AUTH[@]}" "${WEBX}/api/ports/${PORT}")"; echo "${PORTINFO}"
if echo "${PORTINFO}" | grep -q '"used":true' && ! echo "${PORTINFO}" | grep -q "\"name\":\"${NAME}\""; then
    echo "端口 ${PORT} 已被别的进程占用, 不硬上"; exit 1
fi

echo "③ register"
curl -fsS "${AUTH[@]}" "${J[@]}" -X POST "${WEBX}/api/services" -d @- <<JSON
{
  "name": "${NAME}",
  "host": "127.0.0.1",
  "port": ${PORT},
  "protocol": "http",
  "healthPath": "/api/health",
  "description": "HX-Memory 面板: 记忆 / 知识库 / 挫折检测 / 评估 / 模型配置",
  "workdir": "$(pwd)",
  "startCommand": "bash scripts/panel.sh start",
  "source": "ai",
  "ttlMs": 0
}
JSON
echo

echo "④ start"; curl -fsS "${AUTH[@]}" -X POST "${WEBX}/api/services/${NAME}/start"; echo
for _ in $(seq 1 150); do
    curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1 && break
    sleep 1
done

echo "⑤ verify"
curl -fsS "http://127.0.0.1:${PORT}/api/health"; echo "  <- 直连"
curl -fsS "${AUTH[@]}" "${WEBX}/proxy/${NAME}/api/health"; echo "  <- 经 HX-WebX"
curl -fsS "${AUTH[@]}" -o /dev/null -w "首页 %{http_code} %{content_type}\n" "${WEBX}/proxy/${NAME}/"
echo "打开: ${WEBX}/proxy/${NAME}/"
