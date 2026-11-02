# FIX-ROUND-1：BLIND-AUDIT.md 前四条结构性问题的修复与复跑

时间：2026-11-02 22:10–22:45 CST。所有命令都在宿主仓库根（`/home/hx/Loli/code/HXLoLis/components/HX-Memory`）经 `/fs/exec` 执行。`node -v` 输出 `v26.12.0`。
本轮**没有处理**第 5 条提交纪律：没有 commit，`git log -1` 仍是 `62ef9a7`。

下文分两类：「已完成」表示命令跑过、结果贴在旁边；「卡在」表示没做到，并写明原因。

---

## 第 4 条：不可复现（优先修）

### 改了什么
- **构造参数属性改为显式字段赋值**：
  - `src/app/kb-sync.ts`，构造函数 `KbSync`，原为 `private readonly opts`
  - `src/frustration/pipeline.ts`，原为 `private readonly deps`
  - `src/frustration/dedupe.ts`，原为 `private readonly cap = 5000`
  - 三份测试的 `FakeSource` / `TinySource`：`tests/s1/retrieval.test.ts`、`tests/s1/retrieval-vector.test.ts`、`tests/s2/embedding-http.test.ts`
  - 用 python 扫描 `src scripts tests bench dsh` 下所有 `constructor(...)` 的参数列表，改完后不再有 private/public/protected/readonly 修饰。剩下的命中都在注释里，例如 `kb-sync.ts` 的说明注释。
- **`--experimental-transform-types` 统一换成 `--experimental-strip-types`**：共 20 个文件，包括 `scripts/panel.sh`、`scripts/eval/*.ts` 的用法注释、`src/frustration/model.ts` 头注、`DETECT-REPORT.md`、`P1-REPORT.md`、`P2-REPORT.md`、`REPORT-BUILD.md`、`ASSISTANT-CUES.md`。
  - `P1-REPORT.md` 第 60 行原来写着「不能用 strip-types」，已改成更正说明。
  - `BLIND-AUDIT.md` 是原始证据，没动。
  - `MEMORY-DECAY.md` 里写的是旧进程当时的命令行（历史事实），也没动。

### 复跑（Node v26.12.0）
命令前缀都是 `node --experimental-strip-types --no-warnings`：

| 脚本 | code | 输出前几行 |
|---|---|---|
| `scripts/eval/kb-coverage.ts --src /home/hx/Loli/code/HXLoLis/HXLoLi --out .hark-tmp/k3` | **0** | `K3=1.0000 (1022/1022 个文件, 4672 个切片, 34200 ms)  warnings=0` |
| `scripts/eval/kb-retrieval.ts --src /home/hx/Loli/code/HXLoLis/HXLoLi --out .hark-tmp/k12` | **2** | `查询集 120 条, 其中 120 条 question 为空; EVAL 2.2 要求人写问题, 拒绝打分` / `K1/K2 = 未测` |
| `scripts/eval/frustration-detect.ts` | **2** | `A1=0.269 (TP 14 / positives 52)  A2=0.042 (FP 6 / negatives 144)  n=196` / `invalid: sample count 196 is below the EVAL.md 2.3 floor of 600` / `invalid: agreement.json missing` |
| `scripts/eval/train-frustration.ts` | **0** | `A lexicon (现有词表, 不训练): recall 0.269 … fpr 0.042 …` … `选型: A — …` |
| `scripts/eval/concurrency.ts --procs 2 --each 200 --runs 3` | **0** | `{"target":"canonical","run":1,"expected":400,"stored":400,"writeErrors":[0,0],…}` … `M5 = 1.00 (threshold 1.00, runs 6)` |

以下顺带也在 Node 26 上跑过：

| 脚本 | code | 说明 |
|---|---|---|
| `scripts/eval/detect-report.ts --sid f143,f121` | 0 | |
| `scripts/eval/len-feature-dist.ts` | 0 | |
| `scripts/eval/lesson-quality.ts` | 2 | `C1=n/a`，lessons 文件不存在 |
| `scripts/verify-docs.ts` | 0 | |
| `scripts/backfill-sessions.ts --root /home/hx/.dsh/hx-memory-bftrial-20261102 --dry-run --allow-heuristic --limit-sessions 3` | 0 | 对拷贝做 dry-run，没写真库 |

**卡在**：判据要求五个脚本全部 code=0，现在只有 3/5。两条非 0 都不是加载失败，而是脚本按 EVAL 规则主动拒绝打分：
- `kb-retrieval` 返回 2，是因为 120 条问题全空，要等人来写（见第 2 条）。
- `frustration-detect` 返回 2，是因为样本只有 196 条，不到 EVAL 2.3 要求的 600 条，而且只有一个标注人、没有 kappa。

要让这两条返回 0，只能补数据，不能改门槛。这两份数据都不能由我代写。

---

## 第 3 条：「骂人 → 评审 → 不再犯」

### 选型规则改回严格（已完成）
`scripts/eval/train-frustration.ts` 的 `choose` 改为：先过回归门槛，**留出 FPR 点估计大于 0.05 就淘汰**，bootstrap 区间只报告，不作豁免。如果全部淘汰，就写「无候选达标」并回退到词表 A。
`eval-out/train.json` 的 `selectionRule` 已同步为 `strict: exclude iff holdout FPR point estimate > 0.05 …`。

复跑 `node --experimental-strip-types --no-warnings scripts/eval/train-frustration.ts`，code=0，末行如下：
```
选型: A — FPR 点估计 <= 0.05 且过回归门槛的候选按留出召回排序, A 最高 (召回 0.269, FPR 0.042 [0.015, 0.076]); 淘汰: B (回归句 6/15 < A 15/15, …), C (回归句 2/15 …), D (回归句 2/15 …), E (FPR 点估计 0.083 > 0.05, 区间 [0.046, 0.133] 不作豁免)
```
- 结论：满足 A2 ≤ 0.05 的只有 A，它的 A1 = 0.269，**没有候选同时达到 A1 ≥ 0.90 和 A2 ≤ 0.05**。
- 该命令同时把 `src/frustration/model.ts` 重写成 A，所以线上检测从 E 变成了 A，召回从 0.442 降到 0.269。门槛严格后就是这个代价。

### 文档与线上一致（已完成）
- `STATUS.md`、`DETECT-REPORT.md` 的顶部新加了「当前选型 = A」一节，旧内容标为历史记录。
- 面板已重启：旧 pid 104799 收到 SIGTERM 后没有被 systemd 拉起，改用 HX-WebX 的 `POST /api/services/hx-memory-panel/start` 拉起。`panel.sh` 的 flag 修好后，这个 start 已能成功，新 pid 是 204513。
- 宿主探测脚本 `.hark-tmp/probe.py` 的输出：
```
detect 200 {"ok":true,"data":{"current":{"model":"linear-1","candidate":"A",…
eval chosen A A
```

### 判官空配置的明示（已完成）
- `GET /api/model` 新增两个字段：`judgeConfigured`，以及 `judgeMissing`（缺哪几项）。
- 模型页在未配置时显示红色 Alert：「判官未配置, 同轮评审不可用」，并列出缺少的项；已配置时也提示「已配置不等于可用，用测试按钮确认」。
- 探测输出：
```
/api/model 200 {'base_url': '', 'model': '', 'has_key': False, 'judgeConfigured': False, 'judgeMissing': ['base_url', 'model', 'API key']}
/ 200 536215 True        ← 服务中的 HTML 含「判官未配置」
```
- 前端重新构建：vite build code=0，`scripts/panel.dist.html` 共 540112 字节。四段新文案都确认在产物里。**没有在浏览器里渲染检查过。**

### 卡在
- **C1**：`lesson-quality.ts` 返回 code=2，`n=0`，因为判官没配，评审从来没跑过，没有 lessons。
- **C2/C3**：`correction-effect.ts` 还不存在，本轮没写。
- **A1 ≥ 0.90**：现有特征做不到，详细原因见 `DETECT-REPORT.md` 历史部分对漏检的分析。

---

## 第 1 条：没在用（启用与否由用户决定，本轮没启用）

### 现状（`scripts/capture-check.ts`，本轮新增，只读）
```
$ node --experimental-strip-types --no-warnings scripts/capture-check.ts --since 2026-10-01T00:00:00Z     (code=3)
1 profile 选入: false  (/home/hx/.dsh/profiles/web/package.json)
2 dist 含原话闸: false  (…/dist/capture/pipeline.js)
3 capture 账本: 1192 行 {"skipped":771,"stored":421}  最后一次 2026-10-11 14:44 CST
4 schedule 账本 (pre-step): 1268 行  最后一次 2026-10-11 14:49 CST
5 新入库条目: 442, 其中原话 context: 173
判定: 未选入: 插件处于关闭状态 (用户选择), 不采集是预期
```
第 2 行说明了一件事：**插件实际加载的 `dist/` 是 2026-09-19 构建的**，里面没有原话闸，也没有之后所有的 src 修复。如果只改选入、不重建，重新打开后跑的还是旧代码。

### 重新启用的步骤
1. `bash scripts/capture-repair.sh`。它会备份 profile 的 `package.json`，把 `@hengxin666/hx-memory` 追加进 `dsh.profile.bundles`，然后执行 `pnpm run build && pnpm run build:client`。
2. 重启 DSH。
3. 在 DSH 里正常对话一轮。

已核对的部分：
- `capture-repair.sh` 里判定状态的那段 node 代码，在 exec 上原样跑出 `{"installed":true,"spec":"link:…/HX-Memory","selected":false,"bundles":11}`，code=0。
- 构建步骤的等价命令 `npx tsc -p tsconfig.build.json --outDir .hark-tmp/dist-check` 返回 code=0，产物 `capture/pipeline.js` 里有 3 处 `qualityOf`。
- **卡在**：exec 白名单不含 `bash` 和 `pnpm`，所以脚本本身没能在 exec 上整体跑一遍。
- **副作用**：核对过程中我误跑了 `node scripts/build-client.mjs`，它重写了 `dist/dsh/client.bundle.cjs`，现在这个文件与 src 一致。插件处于关闭状态，所以没有影响运行。

### 启用后怎么判断「采集正常」
启用后用这条命令判断：
```
node --experimental-strip-types --no-warnings scripts/capture-check.ts --since <重启 DSH 的时间, ISO>
```
退出码含义：0 = 正常，1 = 选入了但不正常，3 = 未选入。

判断时机和看什么：

| 时机 | 看哪几行 | 正常的样子 |
|---|---|---|
| 重启后对话 1 轮 | 第 2、3、4 行 | 第 2 行为 true（dist 已重建）；第 3 行 capture 至少 1 行；第 4 行 schedule 至少 1 行 |
| 24 小时后 | 面板 Hook 页状态 | 是「已启用且在采集」，不是「已启用但没有数据」（面板用 24 小时作判据） |
| 至少有 20 条 stored 以后 | 第 5 行 | 「其中原话 context」为 0，说明原话闸生效 |

另外：在 `/api/memory/list?pool=derived` 里抽 20 条新条目，人工看合格率。上一轮试跑用的是启发式结构化器，合格率只有 20%；真实启用时需要先配好 LLM 结构化器，否则捕获结果不会有结论。

### 面板 Hook 页三态（已完成）
- 在原有 Alert 的下面加了一排三态图例，当前态加粗，其余两态半透明：
  - 「已启用且在采集」：正常
  - 「已关闭 (用户主动)」：灰色，不报警，账本停更是预期
  - 「已启用但没有数据 (异常)」：红色报警，表示启用了却 24 小时无记录
- 当前探测：`/api/hooks?n=1 200 closed-by-user 535.7`
- **没有在浏览器里渲染检查过。**

---

## 第 2 条：检索质量未知

### M2 召回有用率脚本（已完成，跑出真实数字）
新增 `scripts/eval/memory-recall.ts`。会话日志的读取逻辑从 `scripts/backfill-sessions.ts` 抽到 `scripts/lib/dsh-session-log.ts`，两边共用，backfill 的 dry-run 复跑 code=0。

计算方法：
1. 读 pre-step 账本 `schedule/*.jsonl` 中 `outcome=injected` 的条目 id。
2. 在 DSH 会话日志里取注入时刻之后的那一轮回答。
3. 从库里按 id 取条目正文，做引用核对：
   - **严格**：先去掉本轮用户消息里出现过的词项，剩下的词项不少于 2 个，且至少一半出现在回答里。
   - **宽松**：任意一个词项出现在回答里即算。

```
$ node --experimental-strip-types --no-warnings scripts/eval/memory-recall.ts      (code=1, 低于阈值)
M2_strict=0.004 (9/2072)  M2_loose=0.249 (516/2072)  threshold 0.4  pass=false
注入 643 次 / 2400 条; 库里已无 1, 会话缺 0, 找不到回答 327; doc 条目 0
  context: strict 4/915  loose 288/915
  rule: strict 1/687  loose 35/687
  decision: strict 2/158  loose 59/158
  pattern: strict 2/151  loose 64/151
  preference: strict 0/63  loose 15/63
  fact: strict 0/20  loose 15/20
```
产物在 `eval-out/M2.json`，内含样本。读法：用严格口径算，注入的记忆在下一轮回答里能证明被用上的只有 0.4%，与 2026-10-06 审计的 1.4% 同一个量级。**M2 远低于 0.40，不达标。**

- 退出码：0 = 达标，1 = 测到但不达标，2 = 没有可判样本。
- **卡在**：EVAL 定义的 M2 需要判官判定，再加 20% 人工复核（F5），并且要走 DSH 回放（F7）。判官未配置，所以这部分做不了。脚本输出里写明了这一点。
- J2.5：注入里 doc 条目数为 0。

### K1/K2 填空说明（已完成；问题本身没写）
`docs/kb-queries-howto.md` 写清楚了：
- 每类问题怎么写，哪些字段不能改；
- 填完运行的命令和退出码含义；
- 当前（问题全空）运行的原始输出；
- K1、K2 和分类命中要看哪几个数，以及门限。

120 条问题我一条都没写，这是为了避免泄题。

### 语义检索：明确写为「未启用」（没有接本地 embedding，原因如下）
- 接本地 embedding 需要模型或新依赖，这违反「不引入新依赖」的约束，所以选了明示。
- **面板**：
  - 「记忆 → 检索」上方有常驻黄色 Alert：「当前只有 BM25, 语义检索未启用」。
  - `GET /api/overview` 新增 `retrieval` 字段。探测输出为 `{'semantic': False, 'panel': 'BM25 (词 / bigram 覆盖率); 语义检索未启用 (semantic:no-embedder)', 'online': '…DSH 进程没设这两个变量时, 向量通道是 LexicalEmbedder (词典 + 字级 n-gram), 不是语义模型 (src/app/stack.ts:93-96)'}`。
- **报告**：本文件、`docs/kb-queries-howto.md` 的「与代码的关系」一节。
- 想要真语义检索，需要配置 `HX_MEMORY_EMBEDDING_BASE_URL` 和 `HX_MEMORY_EMBEDDING_MODEL`，即远端 OpenAI 兼容接口。

### 知识库为空
这是上一轮用户选择清库的结果（`KB-PURGED.md`）。K3 和 K1/K2 脚本在临时目录里从博客原文重新建索引，不受清库影响。上面 K3=1.0000 就是这样跑出来的。

---

## 工程纪律（顺带做的部分）

- **备份清理**：`*.bak-20261102-*` 删了 5 个，再扫一遍剩 0：
  - `src/capture/pipeline.ts.bak-20261102-gate`
  - `scripts/backfill-sessions.ts.bak-20261102-unreadable`
  - `scripts/backfill-sessions.ts.bak-20261102-since`
  - `scripts/panel-server.ts.bak-20261102-list`
  - `tests/s2/capture-review-queue.test.ts.bak-20261102-gate`
- **docs-gate**：
  - `AGENTS.md:4` 行末加了 `verify-docs:allow` 标记，那个路径只是写法示意，不是具体文件。
  - `docs/memory-four-timings-comparison.md:19` 删掉了对 `/tmp/up/…` 的引用，改为说明「原文件在临时目录，未入仓库」。
  - `node --experimental-strip-types --no-warnings scripts/verify-docs.ts` 返回 code=0：`verify-docs: 检查 27 份文档, 引用可达、结构合规。`
- **全量测试**：
```
$ npx vitest run          (code=0)
 Test Files  197 passed (197)
      Tests  1468 passed (1468)
   Duration  8.57s
```
- **类型检查**：`npx tsc --noEmit -p .` 返回 code=0。

### 本轮新发现、没修的问题
- `node --experimental-strip-types --no-warnings scripts/verify-structure.ts` 返回 code=1，共 11 处结构问题：8 个文件超过 400 行、`kb-sync.ts` 手写了 shadow 判定、`kb-sync.ts` 和 `coding/precipitate.ts` 两个模块悬空。它不在 vitest 里，本轮没处理。
- 它的参数属性检查正则只匹配带 `:` 的写法，扫描范围也只有 `src/` 和 `scripts/lib`，所以 `dedupe.ts` 里 `cap = 5000` 这种写法查不出来。

## 副作用清单
- `train-frustration.ts` 每次运行都会重写 `src/frustration/model.ts`、`eval-out/train.json` 和 `docs/eval-report.html`；`memory-recall.ts` 会写 `eval-out/M2.json`。
- `dist/dsh/client.bundle.cjs` 被 `build-client.mjs` 重写了（见第 1 条）。
- `.hark-tmp/` 里有本轮的辅助脚本和 `dist-check/`。上一轮留下的 `bf-trial1.json` 里有疑似密钥，仍待用户决定是否删除。
