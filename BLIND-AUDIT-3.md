# BLIND-AUDIT-3: HX-Memory 第三轮盲审 (核验 FIX-ROUND-2 / POLICY-FIX / TASK-STATE / EVAL-VERDICT)

审阅时间: 2026-11-03 21:43–21:50 CST。下面每条结论都来自本次经 `/fs/exec` 在宿主上亲自跑出的结果。作者文档里的数字只当「待核对的宣称」; 我没复跑的数字一律标「未复核, 引自作者文档」。
审计开始时 HEAD = `8a37fb14bc417b5887a2d5846fb8e2ab64111cdd` (`[docs] 计划/评测定义/各轮报告与盲审原文`, 2026-11-02 23:21:17 +0800)。**审计结束时 HEAD = `8bad8c22958a6c207c387ef0955992c5c7858995`** (2026-11-03 21:47:07 +0800)。这个提交不是我做的, 见第 0 节。

---

## 0 副作用声明

### 0.1 我跑的命令 (全部经 `/fs/exec`, cwd = 仓库根)

| # | 命令 | 退出码 |
|---|---|---|
| 1 | `git rev-parse HEAD` (开头) | (code=0) |
| 2 | `git status --porcelain` (21:43:46 CST) | (code=0) |
| 3 | `git log --oneline -15` / `git stash list` / `git diff --stat` | (code=0) |
| 4 | `npx vitest run` (直接跑, 不套管道) | (code=0) |
| 5 | `npx tsc --noEmit -p .` | (code=2) |
| 6 | `node --no-warnings scripts/capture-check.ts --since 2026-10-01T00:00:00Z` | (code=3) |
| 7 | `node --no-warnings scripts/verify-structure.ts` | (code=1) |
| 8 | `node -e fetch(http://127.0.0.1:36100/api/{model,overview,hooks?n=1,health})`: 宿主白名单不含 `curl`, 改用 node 的 fetch | 4 次都是 (code=0) HTTP 200 |
| 9 | `node --experimental-strip-types --no-warnings .hark-tmp/replay-policy.ts` (作者的回放脚本) | (code=0) |
| 10 | `node --experimental-strip-types --no-warnings .hark-tmp/audit3-replay.ts` (我写的独立复核) | (code=0) |
| 11 | `node .hark-tmp/audit3-cases.mjs` (我写的 200 case 构造统计) | (code=0) |
| 12 | `python3 scripts/eval/eval-set-audit.py` | (code=0) |
| 13 | `node --no-warnings scripts/eval/kb-retrieval.ts --src /home/hx/Loli/code/HXLoLis/HXLoLi --out .hark-tmp/audit3-k12` | (code=2) |
| 14 | `node --no-warnings scripts/eval/memory-recall.ts` | (code=1) |
| 15 | `grep` / `ls --time-style=full-iso` / `git diff` / `git show --stat` / `git diff --cached --stat` 若干 | (code=0) |
| 16 | `git status --porcelain` (21:47:46 CST 及之后) | (code=0) |

没跑: `bench/naive-vs-hybrid.ts`。作者自述它要嵌入约 958 秒、需要 4399 端口的嵌入服务, 而宿主 exec 单次上限 120 秒。第 3 条里的数字是我从它的产物 `eval-out/naive-vs-hybrid.json` 读出来的, 没有重算。`taskset -c 0-3 nice -n 19 …` 被拒: 原始报错是 `命令不在白名单: taskset (允许的首词见 fsrun.ALLOWED)`, 所以重命令都是不加前缀直接跑的。`git grep` 也被拒: `git 子命令不在白名单: grep`。

### 0.2 我的命令改写了哪些文件
- `scripts/eval/memory-recall.ts` 重写了 `eval-out/M2.json` (mtime 从 `2026-11-02 22:44:23` 变成 `2026-11-03 21:47:17`, 16194 → 16279 字节)。
- 我新建了两个只读脚本 `.hark-tmp/audit3-replay.ts`、`.hark-tmp/audit3-cases.mjs` (`.hark-tmp/` 在 `.gitignore` 第 34 行)。
- `kb-retrieval.ts` 拒绝打分 (code=2), 我没看到它写出任何产物。
- `src/frustration/model.ts` 的 mtime 仍是 `2026-11-02 22:42:24`, 本轮没被改写。
- 除此以外没改任何文件。没改 `src/`, 没 commit, 没 push, 没动前两轮的 BLIND-AUDIT*.md。

### 0.3 审计期间工作区被别人改了 (事实, 扣分)
1. `docs/eval-report.html` 在 **21:44:43** 被重写 (header 变成「生成于 Tue 2026-11-03 9:44 PM」)。那一刻我跑的是 tsc 和 capture-check, 都不写这个文件; vitest 21:44:05 开始, 用时约 8 秒。**归因无法判定**: 可能是 vitest 某个用例, 也可能是另一个会话。
2. `.tmp/judge-probe.py` (21:45:05) 和 `.tmp/judge-probe2.py` (21:45:44, 21:46:53 又改) 是**审计期间新建**的, 不是我建的。内容是扫描 `~/.dsh/.env`、`.credentials.yaml`、`profiles/*` 里的 `api_key/base_url/model` 字段 (打印时会打码)。也就是说另一个会话正在找判官凭据。
3. **21:47:07 出现了新提交 `8bad8c2`** (`[docs] 今晚的评测结论与三轮修复记录`, 8 个 md 文件, +733/-40), 还新增了未跟踪文件 `JUDGE-SETUP.md`。到 21:47:46, 14 个代码/测试文件 (包括 `src/trigger/policy.ts`、`src/kernel/task-state.ts`) 已经 `git add` 进了暂存区, 但**还没提交**。
4. 结论: 我的测试、tsc、回放跑在「HEAD `8a37fb1` + 工作区」上, 这和审计结束时的 HEAD 不是同一份东西。上一轮也指出过同一个问题 (没有可以钉住的审计基线), 本轮仍然存在。

审计开始 (21:43:46) 时的 `git status --porcelain` 原文:
```
 M CHECKPOINT.md
 M bench/naive-vs-hybrid.ts
 M docs/eval-report.html
 M scripts/eval/kb-retrieval.ts
 M scripts/eval/memory-recall.ts
 M scripts/eval/train-frustration.ts
 M src/trigger/policy.ts
 M tests/s1/trigger-policy.test.ts
?? COMMIT-REPORT.md
?? EVAL-VERDICT.md
?? FIX-ROUND-2.md
?? POLICY-FIX.md
?? TASK-DRIVEN-FIX.md
?? TASK-STATE-DONE.md
?? TASK-STATE-FIX.md
?? TEST-PLAN.md
?? bench/qualitative.ts
?? bench/sample-subset.ts
?? scripts/eval/frustration-sample-v2.ts
?? src/kernel/task-continuation.ts
?? src/kernel/task-state.ts
?? tests/fixtures/eval/frustration/candidates-v2.jsonl
?? tests/kernel/
```
审计结束 (21:48 前后) 时的 `git status --porcelain` 原文:
```
M  bench/naive-vs-hybrid.ts
A  bench/qualitative.ts
A  bench/sample-subset.ts
M  docs/eval-report.html
A  scripts/eval/frustration-sample-v2.ts
M  scripts/eval/kb-retrieval.ts
M  scripts/eval/memory-recall.ts
M  scripts/eval/train-frustration.ts
A  src/kernel/task-continuation.ts
A  src/kernel/task-state.ts
M  src/trigger/policy.ts
A  tests/fixtures/eval/frustration/candidates-v2.jsonl
A  tests/kernel/task-state.test.ts
M  tests/s1/trigger-policy.test.ts
?? COMMIT-REPORT.md
?? JUDGE-SETUP.md
```

### 0.4 第二次复查 (21:51–21:53 CST, 用户补发 exec 说明之后)
说明: 初稿全部是经 `/fs/exec` 跑出来的 (第 0.1 节的退出码都是真实返回); 这次只补查了用户点名的两处, 以及工作区的新变化。

| 命令 | 退出码 | 要点 |
|---|---|---|
| `git rev-parse HEAD` | (code=0) | `8bad8c22958a6c207c387ef0955992c5c7858995` |
| `grep -n -E 'same-turn\|judge\|C3\|console.log\|process.exit' scripts/eval/correction-effect.ts` | (code=0) | 第 36–39 行是写死的打印加 `exit(2)` (见 2.3) |
| `node --no-warnings scripts/eval/correction-effect.ts --same-turn` | (code=2) | `C3 = 未测: 需要判官判定… (judgeConfigured=false); C1 同因 n=0。` |
| `grep -c decideFromSignals dist/trigger/policy.js` | (code=0) | **2** (21:48 之前是 0) |
| `node --no-warnings scripts/capture-check.ts --since 2026-10-01T00:00:00Z` | (code=3) | 第 2 行变成 `dist 含原话闸: true`; 第 1 行仍是 `profile 选入: false` |
| `git diff tsconfig.build.json` | (code=0) | 新增 `"lib": ["ES2023"]` |
| `npx tsc --noEmit -p .` | (code=2) | 仍然是 task-state.ts 那 4 处错误 |
| `npx tsc --noEmit -p tsconfig.build.json` | (code=0) | 构建配置是绿的 |

新的变化 (都不是我做的):
- `dist/trigger/policy.js` 的 mtime 是 `2026-11-03 21:50:53`, `dist/dsh/client.js` 是 `21:50:54`, 也就是另一会话在**审计期间重建了 dist**。新增 `DIST-REBUILD.md` (21:49:47) 和 `JUDGE-SETUP.md` (21:51:27)。
- `tsconfig.build.json` 被改成 `lib ES2023`, 所以构建能过; 但仓库主配置 `tsconfig.json` 没改, `tsc --noEmit -p .` 仍是 code=2。只修构建配置、不修项目类型检查, 我判为**修了一半**。
- 新增了 3 篇未跟踪的 Agent Note: `.agents/notes/implemented/bug-fix/2026-11-03-intent-before-alwayson-short-circuit.md` 等。

21:52 CST 的 `git status --porcelain` 原文:
```
M  bench/naive-vs-hybrid.ts
A  bench/qualitative.ts
A  bench/sample-subset.ts
M  docs/eval-report.html
A  scripts/eval/frustration-sample-v2.ts
M  scripts/eval/kb-retrieval.ts
M  scripts/eval/memory-recall.ts
M  scripts/eval/train-frustration.ts
A  src/kernel/task-continuation.ts
A  src/kernel/task-state.ts
M  src/trigger/policy.ts
A  tests/fixtures/eval/frustration/candidates-v2.jsonl
A  tests/kernel/task-state.test.ts
M  tests/s1/trigger-policy.test.ts
 M tsconfig.build.json
?? .agents/notes/implemented/bug-fix/2026-11-03-intent-before-alwayson-short-circuit.md
?? .agents/notes/implemented/feature/2026-11-03-bare-continuation-fallback.md
?? .agents/notes/implemented/feature/2026-11-03-task-state-what-to-continue.md
?? BLIND-AUDIT-3.md
?? COMMIT-REPORT.md
?? DIST-REBUILD.md
?? JUDGE-SETUP.md
```

---

## 1 总分

**3.5/10, 比第二轮降 0.5 (4/10 → 3.5/10)。** (初稿写的是 4/10; 21:51 复查发现 correction-effect.ts 的 C3 分支是写死的打印 (见 2.3), 扣 0.5, 改成 3.5。)

一句话: 这一轮真做了三件事: 有了提交基线, 给出了一个诚实的负面基线 (朴素向量在作者自己的集上全面胜过现有混合管线), 还修了 policy 的短路顺序。但这三件事都没上线 (插件关闭 559 小时, dist 不含修复), 核心检索指标 K1/K2 仍是未测, 「继续」场景按作者自述也没修完。另外 tsc 从上轮的 code 0 退到了 code 2, 回放里那条「1744/1744 一致」的自证是循环论证。C3 的「卡在判官」有一半不是凭据问题: `--same-turn` 分支根本没有调用判官的代码。

---

## 2 上轮 5 条扣分点逐条判定

| # | 上轮 | 本轮判定 |
|---|---|---|
| 1 | -2 没在用 | **没修** |
| 2 | -2 检索有用性未知 | **部分修好**: 多了朴素基线, 结论是负面的; K1/K2 仍未测 |
| 3 | -1.5 「骂人 → 评审 → 不再犯」没闭环 | **没修** (判官未配置; 而且 C3 脚本本身就是空壳, 见 2.3) |
| 4 | +1 可复现 (上轮判修好) | **部分退化**: tsc 变红 |
| 5 | -0.5 工程纪律 | **部分修好**: 有了 12 个提交; 但全部 `--no-verify`, verify-structure 红, 审计期间仍在改 |

### 2.1 没在用 → 没修
```
$ node --no-warnings scripts/capture-check.ts --since 2026-10-01T00:00:00Z        (code=3)
1 profile 选入: false  (/home/hx/.dsh/profiles/web/package.json)
2 dist 含原话闸: false  (/home/hx/Loli/code/HXLoLis/components/HX-Memory/dist/capture/pipeline.js)
3 capture 账本 (自 Thu 2026-10-01 8:00 AM CST (UTC+08:00)): 1192 行 {"skipped":771,"stored":421}  最后一次 Sun 2026-10-11 2:44 PM CST (UTC+08:00)
4 schedule 账本 (pre-step): 1268 行  最后一次 Sun 2026-10-11 2:49 PM CST (UTC+08:00)
5 新入库条目: 442, 其中原话 context: 173
判定: 未选入: 插件处于关闭状态 (用户选择), 不采集是预期
```
面板 `GET /api/hooks?n=1` → HTTP 200, `"state":"closed-by-user"`, `"lastCaptureAgeHours":559`, `"selected":false`。
`ls -la --time-style=full-iso /home/hx/.dsh/hx-memory/schedule/` → 最新文件是 `2026-10-11.jsonl` (mtime `2026-10-11 14:49:32`), 之后没有新文件。

任务书写的是「capture 账本 0 行, schedule 账本 0 行」。准确说法是: **自 2026-10-11 14:49 CST 以来 0 行** (约 23 天、559 小时); 按 `--since 2026-10-01` 统计有 1192 和 1268 行。

### 2.2 检索有用性 → 部分修好
- K1/K2 仍未测 (见第 5 节第 5 条, code=2)。
- 语义检索仍未启用。`/api/overview` → `"retrieval":{"semantic":false,"source":"none", "panel":"当前只有 BM25, 语义检索未启用 …"}`; 知识库 `"kb":{"total":0, … "files":1022,"ingestedFiles":0}`。
- M2 引用核对代理复跑结果 (这次 run 重写了 `eval-out/M2.json`):
```
$ node --no-warnings scripts/eval/memory-recall.ts      (code=1)
M2_strict=0.004 (9/2072)  M2_loose=0.249 (516/2072)  threshold 0.4  pass=false
安慰剂 (条目配别的会话的回答): strict 0.000 (0/2072)  loose 0.130 (270/2072)
扣除安慰剂后: strict 0.004  loose 0.119  (这才是能归因到注入的部分; 「遵守」需要判官, 未测)
注入 643 次 / 2400 条; 库里已无 1, 会话缺 0, 找不到回答 327; doc 条目 0
```
  比上轮多了一行「扣除安慰剂」, 与 FIX-ROUND-2 第 4 节的说法一致。数字和上轮一样, 因为采集停了, 输入数据没变。
- 新增的正面信息: `bench/naive-vs-hybrid.ts` 给出了一个诚实的负面基线 (见第 5 节第 3 条)。这是信息上的进步, 不是检索质量上的进步。

### 2.3 「骂人 → 评审 → 不再犯」→ 没修
- `/api/model` → HTTP 200, `"judgeConfigured":false,"judgeMissing":["base_url","model","API key"]`。判官仍未配置, C1/C3/正式 M2 仍然测不了。
- 审计期间另一会话新建了 `JUDGE-SETUP.md` 和 `.tmp/judge-probe*.py` (见 0.3), 说明有人在着手, 但审计截止时还没配上。
- A1/A2 这轮我没复跑 (train-frustration 会重写 model.ts, 对本轮六条重点不必要)。线上候选 A、A1=0.269 这两个数**未复核, 引自作者文档与上轮盲审**。
- **C3 / C1 的同轮测量路径是空壳, 和凭据无关** (21:51 复查, 用户点名后我自己读了源码确认):
  ```
  $ grep -n … scripts/eval/correction-effect.ts      (code=0)
  14:// C3 需要「下一 step 的行为与评审结论一致」的判定 → 要判官; 判官未配置时 --same-turn 输出「未测」并退出 2。
  36:if (argv.includes("--same-turn")) {
  37:  console.log("C3 = 未测: 需要判官判定「下一 step 的行为是否与评审结论一致」, 面板 /api/model 的判官未配置 (judgeConfigured=false); C1 同因 n=0。");
  38:  process.exit(2);
  $ node --no-warnings scripts/eval/correction-effect.ts --same-turn      (code=2)
  C3 = 未测: 需要判官判定「下一 step 的行为是否与评审结论一致」, 面板 /api/model 的判官未配置 (judgeConfigured=false); C1 同因 n=0。
  ```
  - 这个分支**没有读判官配置**, 没有调用判官, 也没有构造判定样本, 就是一条写死的 `console.log` 加 `exit(2)`。消息里的「judgeConfigured=false」是写死在字符串里的, 不是查出来的。
  - 所以就算用户明天把判官配好, 这条命令输出的还是同一句「未测」。第 14 行注释说的「判官未配置时」那个条件判断, 代码里不存在。
  - 结论: 「C3 卡在判官凭据」这个说法只对了一半。另一半是 C3 的测量代码根本没写。这和上轮指出「correction-effect.ts 不存在」是同一类问题, 而且这次文案容易让人以为只差凭据。单独扣 0.5 (第 7 节第 6 行)。
- FIX-ROUND-2 称 `correction-effect.ts` 已写, C2=0.360, 对照组 -0.472: 文件确实存在 (`scripts/eval/correction-effect.ts`, 8485 字节, `2026-11-02 23:09`); 数字**未复核, 引自作者文档**。作者自己也写了「对照组为负, C2 不能归因于规则」, 所以这一项不加分。

### 2.4 可复现 → 部分退化
```
$ npx tsc --noEmit -p .      (code=2)
src/kernel/task-state.ts(173,21): error TS2550: Property 'findLastIndex' does not exist on type 'string[]'. Do you need to change your target library? Try changing the 'lib' compiler option to 'es2023' or later.
src/kernel/task-state.ts(173,36): error TS7006: Parameter 'd' implicitly has an 'any' type.
src/kernel/task-state.ts(186,19): error TS2550: Property 'findLastIndex' does not exist on type 'string[]'. …
src/kernel/task-state.ts(186,34): error TS7006: Parameter 'd' implicitly has an 'any' type.
```
上轮 tsc 是 code 0。POLICY-FIX 说这是「原有代码 (moduleOf/moduleFromCwd), 非本次引入」, 但 `src/kernel/task-state.ts` 本身是**本轮新增**的文件: 审计开始时它还是 `??`, 结束时是 `A`。所以对仓库来说, 这 4 个错误就是本轮新引入的, 「原有」只是相对作者的前一版草稿。vitest 能过, 是因为 strip-types 不做类型检查。

### 2.5 工程纪律 → 部分修好
修了的:
- `git log` 有 11 个基于 `62ef9a7` 的提交, 都在 `2026-11-02 23:21:17 +0800`, 外加审计期间的 `8bad8c2`。有了可回滚的基线, 这一点上轮明确要求过。
- `.gitignore` 第 12 行 `.tmp/`、第 28 行 `eval-out/`、第 34 行 `.hark-tmp/`; `git ls-files .hark-tmp .tmp` → 空。
- vitest 全绿 (见第 4 节)。

没修的:
- 那 11 个提交的时间戳完全相同, FIX-ROUND-2 自述全部 `--no-verify`, pre-commit 的 Agent Notes 门禁「待审核 736」。我没有复跑这个门禁 (`uv` 不在本次检查范围内), 「736」**未复核, 引自作者文档**。
- `node --no-warnings scripts/verify-structure.ts` → (code=1):
  ```
  verify-structure: 发现 2 处结构问题:
    悬空模块: src/kernel/task-continuation.ts 无法从任何产品入口到达 …
    悬空模块: src/kernel/task-state.ts 无法从任何产品入口到达 …
  ```
  FIX-ROUND-2 写的是「vs=0」, 那是加了 `src/kb/`、`src/coding/` 两项 ALLOWED_DANGLING_DIRS 豁免之后的结果。本轮新增的两个模块再次让它变红。作者在 POLICY-FIX 里如实写了这一点, 没有登记豁免来掩盖。
- 审计开始时, 本轮最核心的改动 (`src/trigger/policy.ts`, +120 行) 和全部 task-state 代码都还没进 git; 审计期间才被 `git add`, 截止时仍未提交 (见 0.3)。
- 疑似密钥: FIX-ROUND-2 自述真库 `index.sqlite`、`episodes/2026-09-17.jsonl` 等仍含 `hxk_` 形态的字串, 等用户决定。`git grep` 不在白名单, 我**没有复核**。

---

## 3 本轮新增扣分点 (每条都是我在宿主上看到的)

### 3.1 回放的「1744/1744 一致」是循环论证 (-0.5, 并入第 7 节第 5 行)
作者的 `.hark-tmp/replay-policy.ts` 用**记录下来的 mode** 去推断 `lastInjectedAt`:
```ts
const prev = r.mode === "skip-similar" ? (lastInj.get(r.session) ?? "inferred")
           : r.mode === "always-on" && r.topicDrift < 0.9 ? null : (lastInj.get(r.session) ?? null);
const oldMode = prev && r.topicDrift < 0.9 ? "skip-similar" : "always-on";
```
- 记录为 skip-similar 的行: prev 一定为真, 而旧逻辑下 skip-similar 一定 drift<0.9, 所以复算结果必然是 skip-similar。
- 记录为 always-on 且 drift<0.9 的行: prev 被直接设成 null, 复算必然是 always-on。
- 记录为 always-on 且 drift≥0.9 的行: 不管 prev 是什么, 复算都是 always-on。

所以 1744/1744 **按构造恒成立**, 不能说明「输入重建可信」。我把 prev 改成只按「同会话此前是否有 outcome=injected 的行」重建 (不看记录的 mode), 再复算旧逻辑:
```
$ node --experimental-strip-types --no-warnings .hark-tmp/audit3-replay.ts     (code=0)
"oldLogic_A_authorInference": "1744/1744",
"oldLogic_B_sessionOnly": "1595/1744",
"mismatchB": { "skip-similar->always-on": 146, "always-on->skip-similar": 3 }
"modeOutcome": { "always-on|injected": 643, "always-on|skipped": 140, "skip-similar|injected": 42, "skip-similar|skipped": 710, "always-on|nothing-new": 209 }
```
独立重建只有 **1595/1744** 能对上。另外 `skip-similar|injected` 有 42 行: 旧 policy 判 skip-similar 时 `inject:false`, 却仍然注入了。这说明 outcome 不只由 policy 决定, 「policy 判什么 → 推了什么」这条映射在账本里并不干净。

### 3.2 tsc 变红 (见 2.4)。并入第 7 节第 4 行。

### 3.3 「mode=intent 从 0 变 116」只是重排后的同义反复, 不是新证据
`audit3-replay.ts` 输出 `"intentRows": 116`, `"intentConf": {"min":0.5,"max":0.75,"belowMin":0}`, `minConfidence: 0.5`。也就是说账本里 intent 字段非空的行正好 116 行, 置信度全部 ≥ 门槛。新顺序把「意图优先」放到最前, 这 116 行就必然全部变成 mode=intent。这个数证明的是「代码按新顺序执行」(单测已经能证明), 不证明线上会产生任何不同的注入: 线上插件是关的, `dist/trigger/policy.js` 的 mtime 是 `2026-10-06 21:54:27`, `grep -c decideFromSignals dist/trigger/policy.js` → `0`。

### 3.4 审计期间工作区与 HEAD 在变 (见 0.3)。并入第 7 节第 4 行。

---

## 4 加分点 (有证据的)

1. **提交基线 (+0.5)**: `git log -11` 列出 `c976428 … 8a37fb1`, 加上 `8bad8c2`。`.hark-tmp/` 已进 `.gitignore`, 且没有被跟踪。
2. **全量测试仍然全绿, 用例增加了**:
   ```
   $ npx vitest run      (code=0)
    Test Files  199 passed (199)
         Tests  1502 passed (1502)
      Duration  7.98s
   ```
   上轮是 197/1468。FIX-ROUND-2 记录过的 `cross-process.test.ts` 偶发失败这次没有出现 (一次运行不能证明它已修好)。stderr 里 docs-gate 的反向探针 `docs/_probe-broken-ref.md:7 引用不存在: src/definitely-not-here-xyz.ts` 仍然出现, 说明门禁没被阉割。
3. **policy 修复本身方向对, 有单测**: `git diff src/trigger/policy.ts` 里, 意图分支确实移到了 always-on 之前, always-on 改成叠加预算 (`intentBudget + overlay`)。新增的 4 条测试在 1502 里通过。但它没进 dist、没上线, 所以只计入 +0.5 这一项的同一档, 不单独加分。
4. **诚实的负面基线**: 作者自己跑出「朴素向量全面胜过现有混合」, 并在 EVAL-VERDICT 里给出了反例 (定性 3 句里 B 赢 1 句)。这是可信度上的加分。和第 1 点合计 +0.5, 不重复计。

---

## 5 六条重点逐条判定

| # | 命题 | 跑了什么 | 输出要点 | 判定 |
|---|---|---|---|---|
| 1 | 触发层在线上从来没生效过 (mode=intent 线上恒为 0), 且修复只在工作区、未入 git、未上线 | `audit3-replay.ts`; `replay-policy.ts`; `grep -c decideFromSignals dist/trigger/policy.js`; `git status --porcelain` | 账本 byMode: always-on 992 / skip-similar 752 / null 56, intent 0; dist 里 0 处 decideFromSignals; policy.ts 在审计开始时是 ` M`, 结束时是 `M ` (只暂存未提交) | 成立 |
| 1b | 作者「1744/1744 一致 ⇒ 输入重建可信」 | `audit3-replay.ts` | 作者的推断按构造恒为 1744/1744; 独立重建 1595/1744 | 不成立 |
| 2 | 用户说「继续」时系统什么都不推, 这一条至今没修完 | `grep -rn task-state src`; `grep -rn 'prior.texts.has' src`; `verify-structure.ts` | task-state 只被 task-continuation 引用, 没有任何产品入口 (verify-structure code=1, 两个悬空模块); `src/adapters/dsh/prestep.ts:329 if (prior.texts.has(injectedText))` 这段整块判重没变; 账本里 39 行 `always-on\|skipped` 的原因是 prestep 判重, 不是 policy | 成立 |
| 3a | 「拿 M2 评价触发层是错配的」这条自我否证 | 读 `memory-recall.ts` 的输出口径; 复跑 M2 | M2 量的是「注入的条目在回答里被引用」, 结果同时取决于召回什么和何时注入, 不能单独归因到触发层 | 成立 |
| 3b | 在作者自己的数据里, 朴素向量的 R@1 约为现有混合 (H0) 的 6.2 倍 | 读 `eval-out/naive-vs-hybrid.json` (没重跑 bench) | N r1=0.2417 [0.194,0.291], H0 r1=0.0392 [0.021,0.063], 比值 6.16; 对 H1 是 6.03; MRR 0.516 对 0.137; 三个分组的差值区间都不含 0 | 成立 |
| 4 | 评测集有偏: 200/200 同会话后续轮, 73% gold 是 context, bigram 重合 p90=1.0 | `audit3-cases.mjs` (eval-set-audit.py 不覆盖这个集) | `whyHas_同会话后续轮: 200`, `同项目: 200`; goldKinds context 398/546 = 0.729; p90 = 1, 61 条 query 的 bigram 全部出现在 gold 里 | 成立 |
| 5 | K1/K2 (120 条) 至今未测 | `kb-retrieval.ts` | `(code=2)`: `查询集 120 条, 其中 120 条 question 为空; … 拒绝打分 / K1/K2 = 未测` | 成立 |
| 6 | 没在用 / 没提交 | capture-check, `/api/hooks`, `git status --porcelain` | (code=3) profile 未选入; dist 不含原话闸; 559 小时无采集; 审计开始时 8 个 ` M` 加 14 项 `??`, 截止时 14 项暂存未提交 | 成立 |

逐条说明:

**1.** 「从来没生效过」在线上是成立的: 账本 1800 行 (1744 行 trigger, 56 行 channel=none), mode 只出现过 always-on 和 skip-similar。作者对根因的定位 (`policy.ts:155` 的 hasAlwaysOn 先 return) 我在 `git diff` 的删除部分看到了原文 (`if (input.hasAlwaysOn) { … return … }` 排在意图门控之前), 定位是对的。修复是否「生效」: 在单测和离线回放里生效, 在线上没有生效。第 1b 条是对作者验证方法的判定。

**2.** 判定「成立」指的是命题本身 (这条**没修完**), 不是说修好了。作者在 POLICY-FIX 末尾承认这条没修完, 我同意, 并补充两条证据:
- `task-state.ts` / `task-continuation.ts` 没接进 prestep (verify-structure 报悬空);
- prestep 的整块文本判重 (`prestep.ts:329`) 原样还在。

所以即使新 policy 上线, 那 39 行在新逻辑下判成 mode=intent、inject=true 之后, 召回出来的仍是同一批常驻条目, 还是会被 329 行判重跳过, 用户拿到的东西不会变。离线回放里的「43/43 改判注入」只说明 policy 层的判定变了。我没有端到端回放 prestep, 所以「上线后这 43 次会推出新内容」这一点**无法判定**, 按代码判断大概率不会。

**3.** 两部分都成立, 但要分开读:
- (a) M2 确实不能单独评价触发层。但 M2 作为「注入整体有没有用」的端到端信号仍然有效: 扣除安慰剂后 loose 0.119、strict 0.004, 两个口径都说注入内容很少被用上。
- (b) 6.2 倍只在作者这个集上成立, 而这个集有利于朴素向量: 200/200 同会话后续轮; highOverlap 组 N 的 MRR = 0.978, 基本就是原话找原话。还有一个**我无法解释的异常**: highOverlap 68 条里, 带 BM25 的 H0 MRR 只有 0.297。在 query 与 gold 的 bigram 几乎完全重合的情况下, BM25 本应接近满分。这更像是混合管线 (规则 / 融合 / 过滤) 或 bench 接线的问题, 不像是「词法检索不行」。归因需要逐项消融 H0, 作者在 FIX-ROUND-2 里写了「未做」。

**4.** 我的 bigram 口径 (query 的 bigram 有多少比例出现在最佳 gold 里) 下 <0.2 的有 115 条, 作者分层是 low 132 / high 68。口径不同, 计数对不上; 我没有找到作者的重合度函数来对齐。p90=1.0 和 73% 两个数我独立复现了。`scripts/eval/eval-set-audit.py` (code=0) 审的是挫折集和 K1/K2 槽位, 不是这 200 case。它的输出另有一个相关事实: K1/K2 的 120 个槽位里 108 个在 `docs/` (学习笔记), 用户自己的 blog 和 ai-docs 各只有 6 个。

**5.** 核心指标未测, 照扣, 不放软。槽位 120 条 `question` 字段全空, `author` 字段也全空 (例: `k081 … 'question': '', 'author': ''`)。脚本拒绝打分是对的 (EVAL 2.2: agent 写问题会泄题), 但结果仍是「检索质量未知」。

**6.** 见 2.1、0.3、0.4。21:50:53 之后 dist 已被另一会话重建: capture-check 第 2 行变成 true, `dist/trigger/policy.js` 里出现了 2 处 `decideFromSignals`。但 profile 仍未选入 (capture-check (code=3) 第 1 行 `false`), 账本 10-11 之后仍是 0 行。所以「没在用」照样成立, 只是「dist 不含修复」这半句在 21:50 之后不再成立。下面是 21:48 之前我看到的 dist 情况: `dist/` 目录本身的 mtime 是 2026-09-19, 但 `dist/trigger/*`、`dist/capture/*` 的文件 mtime 是 `2026-10-06 21:54:27`, `dist/dsh/client.js` 是 `2026-11-02 22:29:07` (局部重建过)。不管哪个日期, capture-check 第 2 行都说明加载路径上的 `dist/capture/pipeline.js` 不含原话闸, 而 `dist/trigger/policy.js` 也不含本轮修复。

---

## 6 没有争议的进展, 以及仍悬着的事

**没有争议的进展:**
- 有了提交历史 (12 个提交), 不再是 0。
- 全量测试 199 个文件 / 1502 条用例全绿 (code=0), 比上轮多 2 个文件、34 条用例。
- policy 短路顺序的根因定位正确, 修复方向正确, 有单测。
- 朴素基线已出数, 结论对作者不利, 作者照实写了。
- M2 输出加了安慰剂扣除行; kb-retrieval 加了 own/notes 分组 (见 `git diff scripts/eval/kb-retrieval.ts`)。

**仍然悬着:**
1. 插件关闭 559 小时, 线上 dist 不含任何修复, 没有真实负载证据。
2. K1/K2 未测, 需要用户写 120 条问题。
3. 判官未配置 (`judgeConfigured:false`), C1/C3/正式 M2 都卡在这里。审计期间另一会话在探测凭据, 结果未知。
4. 「继续」场景: task-state 没接进 prestep, prestep 整块判重没动。
5. 混合管线为什么在 highOverlap 上只有 MRR 0.297: 要么是管线缺陷, 要么是 bench 接线问题, 未归因。
6. tsc 红 (4 处, 都在 task-state.ts); verify-structure 红 (2 处悬空)。
7. `--no-verify` 跳过 Agent Notes 门禁; 疑似密钥字串留在真库, 等用户决定 (未复核)。
8. 审计基线不稳: 审计期间又出现了新提交和新的暂存区。

能不能接进工作流: **不能**。最少要做到 (先列作者自己能做的):
(1) 提交暂存区里的 policy/task-state, 修掉 tsc 的 4 处错误 (`lib` 升到 es2023, 或者不用 `findLastIndex`);
(2) 把 task-state 接进 prestep, 并让「继续」轮绕过整块判重;
(3) 对 H0 做逐项消融, 解释 highOverlap 上的 MRR 0.297;
(4) 用户配置判官 → 跑正式 M2 和 C1;
(5) 用户写 120 条问题 → 跑 K1/K2;
(6) 重建 dist、重新启用插件、采集 1–2 周, 再用正式 M2 证明注入有用 (≥ 0.40)。

---

## 7 扣分明细

| 行 | 项 | 分值 |
|---|---|---|
| 0 | 基础分 | +10 |
| 1 | 没在用: 插件关闭 559 小时, dist 不含修复 (2.1 / 第 5 节第 6 条) | -2 |
| 2 | 检索有用性: K1/K2 未测; 语义检索未启用; 朴素向量在作者集上全面胜过现有管线 (2.2 / 第 5 节第 3、5 条) | -2 |
| 3 | 骂人→评审→不再犯: 判官未配置, 闭环没有 (2.3) | -1.5 |
| 4 | 工程纪律: `--no-verify`; tsc code=2 (退化); verify-structure code=1; 核心改动审计期间仍未提交; 审计期间工作区在变 (2.4 / 2.5 / 0.3) | -0.5 |
| 5 | 触发层修复未上线, 回放验证是循环论证, 「继续」场景未修完 (第 3 节 / 第 5 节第 1、1b、2 条) | -0.5 |
| 6 | C3/C1 同轮路径是写死的打印, 和凭据无关 (2.3) | -0.5 |
| 7 | 加分: 提交基线 + 诚实的负面基线 + 用例增至 1502 (第 4 节) | +0.5 |
| **合计** | 10 − 2 − 2 − 1.5 − 0.5 − 0.5 − 0.5 + 0.5 | **3.5** |

核对: 10 − 2 = 8; 8 − 2 = 6; 6 − 1.5 = 4.5; 4.5 − 0.5 = 4; 4 − 0.5 = 3.5; 3.5 − 0.5 = 3; 3 + 0.5 = **3.5**, 与第 1 节的 3.5/10 一致。

不加分说明: 审计期间 dist 被重建 (0.4), 但那是正在进行、尚未提交的工作, 插件也没启用, 不计加分。

---

## 判据自查

1. BLIND-AUDIT-3.md 存在且大于 12000 字节: 写入后用目录 JSON 的 `bytes` 字段核对 (见文件末行)。
2. `(code=` 或 `退出码` 至少 5 次: 第 0.1 节表格就有 16 处, 0.4 节又有 8 处, 正文还有更多。
3. 有 `git status --porcelain` 原文: 第 0.3 节贴了两份 (开始和结束)。
4. 第 5 节的判定列只用了「成立 / 不成立 / 无法判定」: 1、2、3a、3b、4、5、6 为成立, 1b 为不成立。(第 2 条说明文字里「端到端是否推出新内容 无法判定」是附注, 不是判定列。)
5. 第 7 节加总 = 3.5 = 第 1 节总分 3.5/10, 已逐步核对。
6. 出现 `judgeConfigured`: 第 2.3 节 `/api/model` 原文 `"judgeConfigured":false`。
