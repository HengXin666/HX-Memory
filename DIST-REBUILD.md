# DIST-REBUILD — 重建 dist 并验证原话闸 (原机)

生成: 2026-11-03 21:5x CST。执行: Hark 经 exec 网关在原机 /home/hx/Loli/code/HXLoLis/components/HX-Memory 上运行 (node v26.12.0)。上一版的镜像结论作废, 下面全部是原机结果。

## 1 结论

**dist 已与 src 同步: 原机 capture-check 第 2 行从 `false` 变为 `true`, 由一次两道都退出 0 的干净构建达成 (tsc EXIT=0, build-client EXIT=0)。** 解阻塞只改了 tsconfig.build.json 的 lib (未进 git), 没有动 src。

## 2 三个问题 (保留上一版结论, 压缩)

### 2.1 构建命令
- `pnpm run build` = `tsc -p tsconfig.build.json` (rootDir=src, outDir=dist, 只收 src/**/*.ts) → dist/**/*.js + .d.ts。
- `pnpm run build:client` = `node scripts/build-client.mjs` → esbuild 打 src/adapters/dsh/client/index.tsx 成 **dist/dsh/client.js** (tsconfig.json 把该目录排除在 tsc 外, 这一个文件只来自这一道)。scripts/verify.sh 第 25–26 行的 build 步骤两道都跑。
- dist 共两道: tsc + esbuild。原话闸在 dist/capture/pipeline.js, 属 tsc 那道。
- 跨包: 原机 node_modules 里**没有 @hengxin666** (目录不存在, 无链接无本地包)。src 只依赖公共 npm 上的 @deepseek-ai/{cordis, dsh-llm, dsh-settings, dsh-tools, dsh-typert-protocol, schemastery}。typescript 5.9.3。

### 2.2 原话闸 (验证靶子)
- src/capture/pipeline.ts 第 145–162 行 (`---- 原话闸 (2026-11-02 ...) ----`), 第 27 行 `import { qualityOf } from "../app/memory-quality.ts"`。
- 判定: `if (!negativeHit && enhanced.kind === "context" && qualityOf(enhanced).origin === "raw") { skipped++; noConclusion++; continue; }`。
- qualityOf (src/app/memory-quality.ts:62): context 条目, content 等于结构化器 conclusion → derived; 命中 FILLER/COMMAND、或不足 QUALITY_MIN_LEN=40 字 → raw; ≥40 字且带提炼结构词且「你/我」≤1 次 → derived; 命中 CONVERSATIONAL → raw; 其余 → raw。
- 在 dist 里应为: pipeline.js 含 `import { qualityOf } from "../app/memory-quality.js"` 与上面那行 if, 且 dist/app/memory-quality.js 存在。

### 2.3 为什么停在 9 月 19 号
- 构建前原机 `stat -c %y dist` = `2026-09-19 11:58:37.811027986 +0800`。
- 根因: 之后没人在原机跑过 tsc。tsc 默认 noEmitOnError=false, 即使类型报错也会写出 .js, 所以"构建一直失败"不会让 dist 停住; 构建前原机 dist 只有 157 个 .js, 缺 46 个 src 模块 (含 app/memory-quality), 说明 tsc 从那以后没执行过。
- .gitignore 第 6 行 `dist/` 让它在 git 里完全不可见, 所以一直没人发现。之前回合 (见 REPORT-BUILD.md) 都在无 node_modules 的镜像里工作, 从没在原机跑 build。
- 同时 src 本身也构建不过 (§3), 跑 verify.sh 会在 build 步红; 但单跑 tsc 照样会写出 dist —— 这正是"失败构建刷绿判据"的陷阱, 本次没有走这条路。

## 3 阻塞点与解法

原机原配置下 (构建前):
```
$ npx tsc -p tsconfig.build.json --noEmit; echo EXIT=$?
src/kernel/task-state.ts(173,21): error TS2550: Property 'findLastIndex' does not exist on type 'string[]'. Do you need to change your target library? Try changing the 'lib' compiler option to 'es2023' or later.
src/kernel/task-state.ts(173,36): error TS7006: Parameter 'd' implicitly has an 'any' type.
src/kernel/task-state.ts(186,19): error TS2550: Property 'findLastIndex' does not exist on type 'string[]'. Do you need to change your target library? Try changing the 'lib' compiler option to 'es2023' or later.
src/kernel/task-state.ts(186,34): error TS7006: Parameter 'd' implicitly has an 'any' type.
EXIT=2
```

**选的路: 首选 —— 只改配置。** tsconfig.build.json 加 `lib: ["ES2023"]` (target 保持继承的 ES2022: 运行时 node ≥22.5 原生有 findLastIndex, 只需类型库, 不改产物语法)。写入带 If-Match d7998b070118b8a28bc3f78cd00790e7, 新版本 0b4c29515cf78db9d2ffd448e185169d。diff 原文 (`git diff tsconfig.build.json`):
```
@@ -4,7 +4,8 @@
     "noEmit": false,
     "outDir": "dist",
     "rootDir": "src",
-    "declaration": true
+    "declaration": true,
+    "lib": ["ES2023"]
   },
   "include": ["src/**/*.ts"],
   "exclude": ["node_modules", "dist", "tests"]
```
改完单独跑:
```
$ npx tsc -p tsconfig.build.json --noEmit; echo EXIT=$?
EXIT=0
```
4 条错全部消失, **没有冒出任何新错**, 所以不需要回滚, 也没有碰 src/kernel/task-state.ts。

为什么选这条: 不碰源码, 不和正在接线 task-state.ts 的会话冲突; 提 lib 无连带错误, 说明项目代码与 ES2023 类型库兼容。
换另一条会怎样: 把 173/186 两处 findLastIndex 改成倒序 for 循环, 语义相同, tsc 同样能通, 但要改一个另一个会话正在改的文件 (该文件在 git 里是新加的 `A` 状态), 有合并冲突风险; 且只解了这两处, 下次有人再用 ES2023 API 还会再卡。

## 4 构建 (原机, 两道)

构建开始: 2026-11-03T13:50:51Z

```
$ npx tsc -p tsconfig.build.json ; echo EXIT=$?
EXIT=0
npm notice run @hengxin666/hx-memory@0.1.0 npx
npm notice run 'tsc' -p tsconfig.build.json
```
**tsc 退出码: 0** (EXIT=0; 唯一输出是 npx 的 notice, tsc 本身无诊断)。

```
$ node scripts/build-client.mjs ; echo EXIT=$?
client bundle -> /home/hx/Loli/code/HXLoLis/components/HX-Memory/dist/dsh/client.js (module id: @hengxin666/hx-memory)
EXIT=0

  dist/dsh/client.bundle.cjs  126.0kb

⚡ Done in 14ms
```
**build-client 退出码: 0** (EXIT=0; esbuild 的进度信息走 stderr, 不是错误)。

注: exec 网关不接受 taskset 前缀, 按任务书直接跑。

## 5 验证前后对照 (原机)

### a capture-check (同一脚本, 未改)
构建前:
```
$ node --no-warnings scripts/capture-check.ts --since 2026-10-01T00:00:00Z; echo EXIT=$?
1 profile 选入: false  (/home/hx/.dsh/profiles/web/package.json)
2 dist 含原话闸: false  (/home/hx/Loli/code/HXLoLis/components/HX-Memory/dist/capture/pipeline.js)
3 capture 账本 (自 Thu 2026-10-01 8:00 AM CST (UTC+08:00)): 1192 行 {"skipped":771,"stored":421}  最后一次 Sun 2026-10-11 2:44 PM CST (UTC+08:00)
4 schedule 账本 (pre-step): 1268 行  最后一次 Sun 2026-10-11 2:49 PM CST (UTC+08:00)
5 新入库条目: 442, 其中原话 context: 173
判定: 未选入: 插件处于关闭状态 (用户选择), 不采集是预期
EXIT=3
```
构建后:
```
$ node --no-warnings scripts/capture-check.ts --since 2026-10-01T00:00:00Z; echo EXIT=$?
1 profile 选入: false  (/home/hx/.dsh/profiles/web/package.json)
2 dist 含原话闸: true  (/home/hx/Loli/code/HXLoLis/components/HX-Memory/dist/capture/pipeline.js)
3 capture 账本 (自 2026-10-01T00:00:00.000Z): 1192 行 {"skipped":771,"stored":421}  最后一次 2026-10-11T06:44:54.124Z
4 schedule 账本 (pre-step): 1268 行  最后一次 2026-10-11T06:49:32.693Z
5 新入库条目: 442, 其中原话 context: 173
判定: 未选入: 插件处于关闭状态 (用户选择), 不采集是预期
EXIT=3
```
第 2 行 false → true; 判定仍是"未选入" (EXIT=3), 因为插件按要求保持关闭, 没有动 profile。第 5 行的 173 条原话 context 是 10 月里用旧 dist 采进来的存量, 重建 dist 不会清掉它们 (见 §7)。

### b grep
模式: `qualityOf`
```
$ grep -c qualityOf dist/capture/pipeline.js     # 构建前
0
(GREP_EXIT=1)
$ grep -c qualityOf dist/capture/pipeline.js     # 构建后
3
$ grep -n qualityOf dist/capture/pipeline.js     # 构建后
19:import { qualityOf } from "../app/memory-quality.js";
112:            // 判据与面板分池**同一个函数** (src/app/memory-quality.ts qualityOf), 不另写一套:
117:            if (!negativeHit && enhanced.kind === "context" && qualityOf(enhanced).origin === "raw") {
```

### c dist/app/memory-quality.js
```
$ ls -l dist/app/memory-quality.js     # 构建前
ls: 无法访问 'dist/app/memory-quality.js': 没有那个文件或目录   (LS_EXIT=2)
$ ls -l dist/app/memory-quality.js     # 构建后
-rw-r--r-- 1 hx hx 3917 11月 3日 21:50 dist/app/memory-quality.js
```
```
$ stat -c '%y %n' dist dist/capture/pipeline.js src/capture/pipeline.ts   # 构建后
2026-11-03 21:50:53.532195534 +0800 dist
2026-11-03 21:50:53.304682131 +0800 dist/capture/pipeline.js
2026-11-02 22:04:55.416644351 +0800 src/capture/pipeline.ts
```

### d 见 §6

## 6 时间戳核对与孤儿文件 (原机, 构建后)
脚本 .hark-tmp/dist-ts-check.mjs (只读): 遍历 dist 下所有 .js, 比对 src 下同名 .ts/.tsx 的 mtime; dist/dsh/client.js 对照 src/adapters/dsh/client/index.tsx。
```
$ node .hark-tmp/dist-ts-check.mjs
dist .js total: 203 | newer-or-equal: 203
DIST_OLDER_THAN_SRC: 0
ORPHANS (dist only): 0
SRC_WITHOUT_DIST: 0
```
- dist 比 src 旧的文件: **0 个**。
- 孤儿 (只在 dist 无对应 src): **0 个**。构建前也没有孤儿 (157 个 .js 都有 src 对应, dsh/client.js 来自 client/index.tsx), 所以 tsc 不清目录在这次不留残渣。构建前缺的 46 个模块现已全部产出 (157 → 203)。

## 7 副作用与遗留
- **tsconfig.build.json 改了一行 (加 lib ES2023), 没有进 git**: `git status` 显示 ` M tsconfig.build.json` (未暂存)。由统一提交的会话决定是否提交; 若不提交, 下次有人重建会再卡在同样 4 条错。
- **tsconfig.json 没改**, 所以 `pnpm run typecheck` (= `tsc --noEmit`, verify.sh 第 2 步) 仍报同样 4 条错 (EXIT=2, 已在原机确认, 且只有这 4 条)。要让 verify.sh 全绿, 需把同一 lib 改动也放进 tsconfig.json (或改 task-state.ts 两处)。本轮按任务书只动了构建配置。
- 原 dist 备份在 .hark-tmp/dist-before/ (157 个 .js, cp -a 保留原 mtime), 已在 .gitignore (第 34 行)。
- 新增 .hark-tmp/dist-ts-check.mjs (只读核对脚本, 已被 .gitignore)。
- 未改 src/、未改 scripts/capture-check.ts、未提交 git、未开插件、未动 profile。
- 插件仍是关闭的; 重新启用后需重启 DSH 才会加载新 dist。库里已有的 173 条原话 context 是存量, 原话闸只挡新入库, 不会回头清理。

## 8 判据自查
1. DIST-REBUILD.md > 2500 字节: 是 (写回后用 curl 核对字节数)。
2. 出现 `dist 含原话闸: true` (构建后, 原机): 是, §5a。
3. 出现 `dist 含原话闸: false` (构建前, 原机): 是, §5a。
4. 至少一条 grep 命令与命中结果: 是, §5b (`grep -c qualityOf dist/capture/pipeline.js` 0 → 3)。
5. 构建命令退出码: 是, tsc EXIT=0, build-client EXIT=0 (§4); 原配置下 tsc EXIT=2 (§3)。
另: true 来自两道都退出 0 的构建, 不是靠 noEmitOnError=false 写出的失败产物; capture-check.ts 判定逻辑未动。全绿。
