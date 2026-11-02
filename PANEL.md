# HX-Memory 面板

React + TypeScript + `@hx/ui` 前端, Node 后端, 监听 `127.0.0.1:36100`, 注册进 HX-WebX (`127.0.0.1:36000`) 后从 `/proxy/hx-memory-panel/` 打开。

## 启动与注册 (在本机仓库根目录)

```bash
bash scripts/panel-register.sh     # 查端口 → POST /api/services → POST /api/services/hx-memory-panel/start → 经 /proxy 验收
# 或手动:
bash scripts/panel.sh start        # 构建前端到 .tmp/panel/dist, 前台起服务
```

注册项带 `workdir` + `startCommand: bash scripts/panel.sh start`, 所以之后可以直接在 HX-WebX 面板上启停、看日志。

## 每一页读的是什么

| 页 | 数据来源 (scripts/panel-server.ts) | 能做什么 |
|---|---|---|
| 总览 / Hook | `openMemoryStack(记忆根).facade.stats()`; 记忆根下 capture / episodes / daily / digest / review / review-capture / rules / schedule 的文件数与最新 mtime; `~/.dsh/hooks` 目录 | 看条目数, 每条链路最后一次落盘时间 (超过 24 小时标黄) |
| Hook | `GET hooks`: settings.yaml 的 hx-memory 段 + schedule/ capture/ review 账本 | 看开关来源与最近的注入/捕获 |
| 记忆 | `memory/banks`, `memory/recent` (只查 kind≠doc), `memory/search` (按 kind 分组, 默认排除知识库), `memory/entry` | 检索, 看命中通道、分数、是否被同话题新条目压住 |
| 时间衰减 | `GET decay`: `src/kernel/temporal.ts` 的参数与曲线 + `eval-out/decay-derivation.json` + always-on 改前/改后 | 看 R(age) 曲线、每条规范性条目的有效置信度、被压住不再注入的条目 |
| 知识库 | `<配置目录>/panel.json` 的来源列表 + `walkMarkdown`; 同步走 `KbSync.syncOnce` (src/kb/kb-sync.ts) | 添加/移除路径, 一键同步进记忆根 (写 kind:doc 条目) |
| 检测 | `createDetector({model: MODEL})` 与 `LEXICON_MODEL` 同一个 detect; 可选 `compensateAtTurnEnd` | 输入一句话看两个模型的 HIT/MISS、分数和特征贡献 |
| 评估 | eval-out/*.json; 回归集 tests/fixtures/eval/frustration/regression.jsonl **现场重跑** | 候选对比, 回归通过数, 句长分布 |
| 模型配置 | `<配置目录>/panel.json` | OpenAI 兼容 baseUrl / model / key, 测试 `/models` 和一次 `/chat/completions` |

前端产物: `scripts/panel.dist.html` 是在别处构建好的单文件 (React + @hx/ui, 含样式), 服务优先发它, 本机不需要 vite。
改了 `scripts/panel-app.tsx` 之后要重建它; `bash scripts/panel.sh build` 仍可在本机出 `.tmp/panel/dist` (服务在没有单文件时退回它)。

## 密钥

- API key 只在保存时发给本机后端, 用 AES-256-GCM 加密后写进 `panel.json` (`keyEnc` 字段), 前端只拿到掩码。
- 主密钥: 设了 `HX_PANEL_SECRET` 就用它 (不落盘); 否则首次生成 `~/.config/hx-memory-panel/master.key` (0600)。
- 配置目录可用 `HX_PANEL_CONFIG_DIR` 换。

## 环境变量

`HX_MEMORY_ROOT` (默认 `~/.dsh/hx-memory`), `HX_PANEL_PORT` (36100), `HX_PANEL_DEPS` (前端依赖所在 node_modules), `HX_WEBX_URL` (http://127.0.0.1:36000), `HX_PANEL_NAME` (hx-memory-panel)。

## 为什么这样布局

- 前端源码平铺在 `scripts/panel-*.{html,tsx,ts,css}`, 构建时由 `scripts/panel.sh` 暂存到 `.tmp/panel/`: 写入通道不能建新目录。
- 本仓库没装 vite / tailwind / react-dom / @hx/ui, 默认借 `HX-AI-Review/cf-admin/node_modules` (vite 8.3.4, @tailwindcss/vite 4.3.3, @vitejs/plugin-react 6.1.2, react 19.3.0)。
- 不套 `hx-subpath-adapter.mjs`: 跑的是 `vite build` 产物, `base: "./"`, 请求全用相对路径 `api/...`; 适配层只为 Vite dev server 的根绝对引用存在。

## 已知限制

- 面板的检索关掉了语义通道 (`embedder: null`), 结果会标 `semantic:no-embedder`; 线上 DSH 若配了 `HX_MEMORY_EMBEDDING_*` 会多一条向量通道。
- 模型配置目前只被面板自己使用 (连通性测试); DSH 插件读的仍是它自己的环境变量与 DSH 模型, 还没接这份配置。
- hook 页的环境变量是面板进程自己的, 不代表 DSH 进程; 以落盘时间为准。
