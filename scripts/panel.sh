#!/usr/bin/env bash
# scripts/panel.sh — HX-Memory 面板: 暂存前端源码 → vite build → 起后端 (127.0.0.1:36100)。
#
#   bash scripts/panel.sh build   只构建前端到 .tmp/panel/dist
#   bash scripts/panel.sh start   构建 (若无产物) 并前台起服务; HX-WebX 的 startCommand 就是它
#   bash scripts/panel.sh serve   不构建, 直接起服务
#
# 为什么前端源码是 scripts/panel-*.{tsx,ts,css,html} 平铺, 构建时再暂存进 .tmp/panel/:
#   文件写入通道不能建目录, 只能写进已有目录; 暂存这一步在本机跑, 这里可以 mkdir。
# 依赖从哪来: 本仓库没装 vite / tailwind / react-dom / @hx/ui。默认借 HX-AI-Review/cf-admin 已装好的 node_modules
#   (vite 8.3.4, @tailwindcss/vite 4.3.3, @vitejs/plugin-react 6.1.2, react 19.3.0, @hx/ui), 用 HX_PANEL_DEPS 可换。
# 不套 hx-subpath-adapter: 跑的是 vite build 产物 (base "./", 请求全相对路径), 适配层只为 dev server 的根绝对引用存在。
set -Eeuo pipefail
cd "$(dirname "$0")/.."
REPO="$(pwd)"
DEPS="${HX_PANEL_DEPS:-/home/hx/Loli/code/HXLoLis/components/HX-AI-Review/cf-admin/node_modules}"
STAGE="${REPO}/.tmp/panel"
PORT="${HX_PANEL_PORT:-36100}"

build() {
    for m in vite @tailwindcss/vite @vitejs/plugin-react react react-dom @hx/ui/src tailwindcss; do
        [[ -e "${DEPS}/${m}" ]] || { echo "缺依赖 ${DEPS}/${m} (设 HX_PANEL_DEPS 指向装好这些包的 node_modules)"; exit 1; }
    done
    mkdir -p "${STAGE}/src"
    cp scripts/panel.html "${STAGE}/index.html"
    cp scripts/panel-vite.config.ts "${STAGE}/vite.config.ts"
    cp scripts/panel-main.tsx "${STAGE}/src/main.tsx"
    cp scripts/panel-app.tsx "${STAGE}/src/App.tsx"
    cp scripts/panel-ui.ts "${STAGE}/src/ui.ts"
    cp scripts/panel.css "${STAGE}/src/styles.css"
    ln -sfn "${DEPS}" "${STAGE}/node_modules"
    (cd "${STAGE}" && node "${DEPS}/vite/bin/vite.js" build --logLevel warn)
    echo "built: ${STAGE}/dist"
}

serve() {
    exec node --experimental-strip-types --no-warnings scripts/panel-server.ts --port "${PORT}" --dist "${STAGE}/dist"
}

case "${1:-start}" in
    build) build ;;
    serve) serve ;;
    # 仓库里带了预构建单文件 scripts/panel.dist.html 时直接起服务 (服务优先发它), 不依赖本机 vite。
    start) [[ -f scripts/panel.dist.html || ( -f "${STAGE}/dist/index.html" && "${HX_PANEL_REBUILD:-1}" == "0" ) ]] || build; serve ;;
    *) echo "用法: $0 [build|start|serve]"; exit 2 ;;
esac
