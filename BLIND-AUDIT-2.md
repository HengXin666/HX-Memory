# BLIND-AUDIT-2 — HX-Memory 第二轮盲审 (核验 FIX-ROUND-1)

审阅时间: 2026-11-02 22:40–22:50 CST。全部结论来自本次经 `/fs/exec` 在宿主上亲自跑出的结果。FIX-ROUND-1.md 只当「待核对的宣称」。
宿主: `node --version` → `v26.12.0`。HEAD = `62ef9a7b8f94d00fa6d3fb69c3bc207938366cd3` (Sat Oct 31 19:15:31 2026 +0800, `Merge pull request #4 …`)。

> **副作用声明**: 本次跑 `train-frustration.ts` / `frustration-detect.ts` / `concurrency.ts` / `lesson-quality.ts` / `memory-recall.ts` / `kb-coverage.ts` / `kb-retrieval.ts` 时, 脚本自己重写了 `src/frustration/model.ts` (内容仍是 A, 选型不变)、`eval-out/*.json`、`docs/eval-report.html`, 并在 `.hark-tmp/audit2-k3`、`.hark-tmp/audit2-k12` 下写了产物。除此以外没改任何文件。
>
> **审计期间工作区在被别人改**: `scripts/eval/memory-recall.ts` 的 mtime 是 `2026-11-02 22:43:14`, 晚于 FIX-ROUND-1.md (`22:37:23`) 和我第一次跑它的时间 (`eval-out/M2.json` 22:42:50); 第二次跑时输出多了一行「安慰剂」。`.hark-tmp/b1.py`–`b4.py` 也是 22:42 新建的。也就是说**我审的对象在审的过程中还在变**, 这本身就是第 5 条 (不提交) 的直接后果: 没有 commit 就没有可以钉住的审计基线。

---

## 一 上轮 5 条扣分点逐条

| # | 上轮扣分 | 本轮判定 |
|---|---|---|
| 1 | -2 没在用 | **没修** (理由成立, 但事实不变) |
| 2 | -2 检索质量未知 | **部分修好** (有了代理测量, 结果是坏消息) |
| 3 | -1.5 「骂人 → 评审 → 不再犯」没闭环 | **部分修好** (规则改诚实了, 闭环仍没有) |
| 4 | -1 不可复现 | **修好了** |
| 5 | -0.5 工程纪律 | **部分修好** (docs-gate / 备份 / 文档一致性修了; 提交仍为 0) |

### 1. 没在用 → 没修

```
$ node --no-warnings scripts/capture-check.ts --since 2026-10-01T00:00:00Z        (code=3)
1 profile 选入: false  (/home/hx/.dsh/profiles/web/package.json)
2 dist 含原话闸: false  (…/HX-Memory/dist/capture/pipeline.js)
3 capture 账本 (自 Thu 2026-10-01 8:00 AM CST): 1192 行 {"skipped":771,"stored":421}  最后一次 Sun 2026-10-11 2:44 PM CST
4 schedule 账本 (pre-step): 1268 行  最后一次 Sun 2026-10-11 2:49 PM CST
5 新入库条目: 442, 其中原话 context: 173
判定: 未选入: 插件处于关闭状态 (用户选择), 不采集是预期
```
面板 `GET /api/hooks?n=1` → `"state":"closed-by-user","lastCaptureAgeHours":536`。

- 插件仍关闭, 536 小时无采集。「启用与否由用户决定」这个理由**成立**, 我不扣作者人品分, 但扣分点针对的是「没有真实负载下的证据」, 这个事实一点没变。
- 新暴露的问题更重: 第 2 行说明插件实际加载的 `dist/` 是旧构建 (作者称 2026-09-19), 不含原话闸和之后所有 src 修复。也就是说**过去所有在 src 上做的修复, 线上一行都没跑过**。重新启用必须先重建, 作者给了 `scripts/capture-repair.sh`, 但没在宿主上整体跑过 (白名单无 bash/pnpm, 这条自述属实)。

### 2. 检索质量未知 → 部分修好

- **M2 代理有了, 能跑, 数字对得上** (见二)。但量出来的是坏消息: `M2_strict=0.004 (9/2072)`, 安慰剂 `0.000 (0/2072)`; `M2_loose=0.249`, 安慰剂 `0.130`。
- **K1/K2 仍未测**:
  ```
  $ node --no-warnings scripts/eval/kb-retrieval.ts --src /home/hx/Loli/code/HXLoLis/HXLoLi --out .hark-tmp/audit2-k12     (code=2)
  查询集 120 条, 其中 120 条 question 为空; EVAL 2.2 要求人写问题, 拒绝打分
  K1/K2 = 未测
  ```
- **语义检索仍未启用**, 只是现在明示了: `GET /api/overview` → `"retrieval":{"semantic":false,"panel":"BM25 (词 / bigram 覆盖率); 语义检索未启用 (semantic:no-embedder)", …}`。
- 知识库仍是 0 条 (用户选择, `/api/overview` kb total 0)。

从「完全不知道」变成「有一个粗糙代理, 它说大概没用」。这不是加分的方向。

### 3. 「骂人 → 评审 → 不再犯」→ 部分修好

**选型规则确实改严了**, 而且是真改, 不是只改文档:
```
$ node --no-warnings scripts/eval/train-frustration.ts      (code=0)
A lexicon (现有词表, 不训练): recall 0.269 boot[0.123, 0.417]  fpr 0.042 boot[0.015, 0.076]  TP14 FN38 FP6 TN138  回归 15/15
…
E rules + 词表兜底 (B ∪ A): recall 0.442 boot[0.268, 0.615]  fpr 0.083 boot[0.046, 0.133]  TP23 FN29 FP12 TN132  回归 15/15
字面规则 (上界 <= 0.05) 存活: 无
选型: A — FPR 点估计 <= 0.05 且过回归门槛的候选按留出召回排序, A 最高 (召回 0.269, FPR 0.042 [0.015, 0.076]); 淘汰: B (回归句 6/15 …), C (回归句 2/15 …), D (回归句 2/15 …), E (FPR 点估计 0.083 > 0.05, 区间 [0.046, 0.133] 不作豁免)
```
代码核对 (`scripts/eval/train-frustration.ts:99` `FPR_TARGET = 0.05`; `choose()` 第 114 行 `(r.fpr ?? 1) > FPR_TARGET` 直接淘汰, 区间只进说明文字)。全部淘汰时返回 `qualified:false` 和「这不是达标」, 不会悄悄回退冒充达标。

线上一致:
- `src/frustration/model.ts` 头注与 `meta.candidate: "A"` 一致。
- 面板 `POST /api/detect` (「你又搞错了，我说的不是这个」) → `"candidate":"A"`, `matched:["错了","搞错","不是这个"]`。
- `STATUS.md`、`DETECT-REPORT.md` 顶部「当前选型 = A」与实跑逐数一致, 旧内容标为历史。

但闭环本身:
- A1 = 0.269 (要求 0.90), 比上轮线上的 E (0.442) 还低。这是诚实的代价, 不是改进。
- `frustration-detect.ts` → `A1=0.269 A2=0.042 n=196`, code 2: `sample count 196 is below the EVAL.md 2.3 floor of 600` / `agreement.json missing`。
- 判官未配置: `/api/model` → `"judgeConfigured":false,"judgeMissing":["base_url","model","API key"]`。
- C1: `lesson-quality.ts` → `C1=n/a (concrete 0 / 0)`, code 2。
- C2/C3: `correction-effect.ts` 仍不存在。

一个注意点: 严格规则用的是 FPR **点估计** ≤ 0.05; A 的上界 0.076 也 > 0.05 (输出里「字面规则 (上界 <= 0.05) 存活: 无」)。按 J3.1 字面 (A2 ≤ 0.05 是点值) 这是正当读法, 不算放宽, 但 196 条样本下 A 的 A2 达标在统计上并不稳。

### 4. 不可复现 → 修好了

```
$ node --no-warnings scripts/eval/kb-coverage.ts --src /home/hx/Loli/code/HXLoLis/HXLoLi --out .hark-tmp/audit2-k3     (code=0)
K3=1.0000 (1022/1022 个文件, 4672 个切片, 21737 ms)  warnings=0
```
- 构造参数属性: `grep -rn -E 'constructor\((private|public|protected|readonly)' src scripts tests bench --include=*.ts` → 只剩 6 处**注释**命中 (如 `src/app/kb-sync.ts:154  // 显式字段, 不用参数属性 …`), 无代码命中。
- `--experimental-transform-types` 残留: `grep -rln` → 只剩 `MEMORY-DECAY.md` (历史命令行, 作者声明保留)、`BLIND-AUDIT.md` (上轮证据)、`FIX-ROUND-1.md`、`P1-REPORT.md:60` (内容是更正说明, 已核对)、`.hark-tmp/rep.py`、`.hark-tmp/fx4.py` (替换用的辅助脚本)。
- 抽查 strip-types 已换: `scripts/panel.sh` (serve 段 `exec node --experimental-strip-types …`)、`src/frustration/model.ts`、`DETECT-REPORT.md`(6 处)、`P2-REPORT.md`(3)、`REPORT-BUILD.md`(2)、`ASSISTANT-CUES.md`(1)、`scripts/eval/` 下 18 个 ts/sh。「20 个文件」这个数**无法精确核对**: 这些文件大多是未跟踪文件, 没有 diff 基线; 但抽查全部对, 残留清单与自述一致。
- `npx tsc --noEmit -p .` → code 0, 无输出。
- 顺带: 上轮我把 K3 分母列为疑点 (「非隐藏 ai-docs 88 篇, K3 只记 44」)。本轮用 `os.walk` 排除任意一级点目录重数 → **44** 篇 (`003-AI 25, 002-程序语言 7, 007-音视频特效 5, 004-工具链 4, …`), 与 `K3.json perDir {"ai-docs":{"files":44,"covered":44}}` 一致。**上轮这个疑点是我数错了, 撤回。**

### 5. 工程纪律 → 部分修好

修了的:
- docs-gate: 全量 vitest 绿 (见四), `node --no-warnings scripts/verify-docs.ts` → `verify-docs: 检查 27 份文档, 引用可达、结构合规。` (code 0)。
- 备份文件: `find . -name '*.bak-2026*' -not -path './node_modules/*'` → 空。
- STATUS / DETECT-REPORT 与线上一致 (见 3)。

没修的:
```
$ git log -1 --format=%H%n%ad%n%s
62ef9a7b8f94d00fa6d3fb69c3bc207938366cd3
Sat Oct 31 19:15:31 2026 +0800
Merge pull request #4 from HengXin666/code-task-precipitate
$ git status --short     → 30 个 M, 49 个 ?? (含 src/frustration/、src/app/kb-sync.ts、scripts/eval/、全部报告)
$ git stash list         → 空
```
- **提交数仍为 0**。FIX-ROUND-1 开头就承认「本轮没有处理第 5 条」。exec 白名单允许本地 `git commit`, 没有任何外部阻碍, 这是没做, 不是做不了。
- 后果已在本次审计中实际发生: 审计进行中 `memory-recall.ts` 被改 (见开头), 我和作者看到的不是同一份代码。
- `.hark-tmp/` 有 40+ 个一次性 py 脚本, 外加 `bf-trial1.json` (作者自己说含疑似密钥) 仍在工作区, 且 `.hark-tmp/` 未进 `.gitignore` (本轮 `.gitignore` 只加了 `eval-out/` 和 `.hark-bak/`)。一次 `git add .` 就会把疑似密钥提交进去。
- 本轮没有新增任何测试: vitest 用例数 1468, 与上轮一字不差。新的 `choose()` 严格规则、`memory-recall.ts` 的判定函数、`capture-check.ts` 都没有单测 (`grep -rln -E 'choose\(|FPR_TARGET' tests scripts/eval` 只命中 `train-frustration.ts` 本身)。

---

## 二 新增功能核验

### `scripts/eval/memory-recall.ts` — 能跑, 数字对得上, 但它不是 EVAL 的 M2

```
$ node --no-warnings scripts/eval/memory-recall.ts      (code=1)
M2_strict=0.004 (9/2072)  M2_loose=0.249 (516/2072)  threshold 0.4  pass=false
安慰剂 (条目配别的会话的回答): strict 0.000 (0/2072)  loose 0.130 (270/2072)
注入 643 次 / 2400 条; 库里已无 1, 会话缺 0, 找不到回答 327; doc 条目 0
  context: strict 4/915  loose 288/915
  rule: strict 1/687  loose 35/687
  decision: strict 2/158  loose 59/158
  pattern: strict 2/151  loose 64/151
  lesson: strict 0/78  loose 40/78
  preference: strict 0/63  loose 15/63
  fact: strict 0/20  loose 15/20
口径: 引用核对 (无判官); EVAL M2 的判官 + 20% 人工复核未做。
```
核对:
- 主数字与 FIX-ROUND-1 一致 (0.004 / 0.249 / 643 次 / 2400 条 / 327)。
- **FIX-ROUND-1 漏了一行**: 它的分类表没有 `lesson: strict 0/78 loose 40/78`, 列出的各类加起来是 1994, 不是 2072。小错, 但「数字全部贴原文」这一点不成立。
- 阈值 0.40 没改 (`THRESHOLD = Number(opt("threshold") ?? "0.40")`), 退出码诚实 (未达标 = 1)。
- 方法 (读源码 `judge()`): 条目词项 = ≥4 字符 ASCII 词 + 中文 4-gram; 严格 = 去掉用户本轮原话词项后剩 ≥2 个且 ≥50% 出现在回答。
- **效度问题**: 安慰剂对照是在 FIX-ROUND-1 写完之后才加进去的 (mtime 22:43:14)。它说明:
  - 严格口径真实 9/2072 vs 安慰剂 0/2072 — 有信号, 但 50% 的 4-gram 原样复现这个门槛太苛刻, 正常转述的「用上」也判不中。0.004 只能说明「几乎没有原样复述」, **不能**说明「记忆没用」。
  - 宽松口径真实 0.249 vs 安慰剂 0.130 — 一半是词汇巧合。扣掉安慰剂后的净信号约 0.12。
  - 严格命中的 9 条样本里有 `"是的，以A为准，这边是专门优化了的"` 这种 context 原话, 不是提炼后的记忆。
- 结论: 它是一个**有诚实对照的引用核对代理**, 不能写成「M2 = 0.004」。按 EVAL 的定义 (判官 + 20% 人工复核 + 回放), M2 仍然是未测。但两个口径加对照都指向同一个方向: 注入内容被用上的比例很低。

### `scripts/capture-check.ts` — 真的, 输出与自述逐行一致

见一·1。五行输出、code=3、判定语都与 FIX-ROUND-1 一致。它是只读的, 退出码 0/1/3 的语义写清楚了。没有单测。

### `docs/kb-queries-howto.md` — 真的, 内容可用

存在 (3893 字节, 22:34:49), 讲清了 120 个槽位每类怎么写、哪些字段不能改、命令、退出码、门限 (K1 ≥ 0.80, K2 ≥ 0.60, 与 EVAL 一致)。贴的「当前输出」与我跑 `kb-retrieval.ts` 的输出逐字一致。它明确写了 K1/K2 测的是**字面检索**。合格。

### FIX-ROUND-1 其余数字 — 逐项复跑

| 宣称 | 我的复跑 | 一致? |
|---|---|---|
| kb-coverage K3=1.0000, 1022/1022, 4672 切片, code 0 | 同, 21737 ms | ✓ |
| kb-retrieval code 2, 120 条空 | 同 | ✓ |
| frustration-detect A1 0.269 / A2 0.042 / n 196, code 2 | 同 | ✓ |
| train-frustration code 0, 选 A, E 因 FPR 0.083 淘汰 | 同 | ✓ |
| concurrency `--procs 2 --each 200 --runs 3` M5=1.00 runs 6 | 6 次全 `stored=400, writeErrors=[0,0]`, `M5 = 1.00 (threshold 1.00, runs 6)` | ✓ |
| lesson-quality code 2, C1=n/a | `C1=n/a (concrete 0 / 0)`, code 2 | ✓ |
| verify-docs code 0, 27 份 | 同 | ✓ |
| vitest 197 / 1468 全过 | 同 | ✓ |
| tsc code 0 | 同 | ✓ |
| verify-structure code 1, 11 处 | 同, 11 处逐条一致 | ✓ |
| /api/detect candidate A; /api/model judgeConfigured false | 同 | ✓ |
| 面板 pid 204513 | `/api/health` → `"pid":204513` | ✓ |
| M2 分类表 | 漏了 lesson 行 (78 条) | ✗ (小) |
| 「20 个文件」换 flag | 无 diff 基线, 抽查全对 | 未能精确核对 |
| 前端新文案渲染 | 作者自认没在浏览器看过, 我也没看 | 未核对 |

**没有发现伪造数字。**

---

## 三 有没有新引入的降门槛或规避

**主线: 这一轮是把判据收紧, 不是放宽。** 具体:

1. **选型规则**: 从「区间覆盖 0.05 即保留」改回「点估计 > 0.05 即淘汰」, 代价是线上召回从 0.442 掉到 0.269, 作者照实写了。这是上轮最大的降门槛问题, 修得干净。
2. **EVAL 阈值没动**: `EVAL.md` mtime `2026-11-01 16:32`、`PLAN.md` `2026-11-01 16:37`, 本轮没碰。K1/K2 门限、M2 0.40、A2 0.05、样本下限 600 都还在, 脚本在不满足时拒绝打分。
3. **docs-gate 测试本身没被动**: `tests/s1/docs-gate.test.ts` mtime `2026-09-11`。它里面的反向探针 (`docs/_probe-broken-ref.md`) 本次运行在 stderr 打出了 `引用不存在: src/definitely-not-here-xyz.ts` 并被测试判为预期 — gate 没被阉割。
4. **AGENTS.md 的 `verify-docs:allow` — 我判为正当豁免, 不是规避**:
   - 该标记是仓库早已存在的机制 (`scripts/verify-docs.ts` 注释、`.agents/notes/implemented/process/2026-09-10-live-settings-and-doc-gates.md:42`), 仓库文档里另有 11 处同类用法 (README、docs/adr、docs/dsh-trigger-points 等)。
   - 被豁免的 `.agents/notes/...md` 本来就不是文件引用, 是「写法示意」, 标记里写了原因, 只作用于这一行。
   - 另一处 (`docs/memory-four-timings-comparison.md:19`) 用的是正面修法: 删掉 `/tmp/up/…` 引用。
   - 两个小保留: (a) 更好的修法是让 `verify-docs.ts` 把含 `...` 的路径识别为占位符, 而不是逐行豁免; (b) 第 4 行在 `<!-- agent-notes:start/end -->` 受管块里, 如果这个块由生成器维护, 标记可能被覆盖, gate 会再红。都不构成规避。
5. **`vitest.config.ts` / `tsconfig.json` 加了排除**: vitest 加 `exclude: ["**/node_modules/**", "**/.hark-bak/**"]`, tsconfig 加 `"**/.hark-bak/**", "scripts/panel-ui.ts", "scripts/panel-vite.config.ts"`。前者合理 (写入通道的备份目录)。后者把两个面板前端文件移出了类型检查 — 有可能是因为它们依赖仓库外的 node_modules, 但 git diff 看不出这是哪一轮加的 (都是未提交改动), 也没有说明。**列为小疑点**: 「tsc 干净」不覆盖面板前端。
6. **「卡在」的理由逐条判断**:

| 卡点 | 理由 | 判断 |
|---|---|---|
| K1/K2 问题要人写 | EVAL 2.2: agent 写会泄题 | **成立** |
| frustration-detect 样本 < 600、单标注 | 标注要人做 | **基本成立**; 但扩大候选样本、给出待标池这一步 agent 能做, 没做 |
| 判官 / C1 / M2 正式版 | 缺 base_url / model / key | **成立** (要用户给 key), 但这是三项指标共同的单点, 作者没有把它列为第一优先请求用户 |
| C2/C3 `correction-effect.ts` | 「本轮没写」 | **不成立**: 写脚本不需要任何人, 就是没做 |
| 插件启用 | 用户决定 | **成立**; 但旧 dist 的问题 agent 能先在临时目录完整演练 |
| 语义检索 | 不引新依赖 | **成立** (远端嵌入要用户提供端点) |
| 提交 | 未说明理由 | **不成立**: 本地 commit 在白名单内 |

结论: 没有新的降门槛。有两条把「没做」写成了「卡在」(C2/C3、提交), 但作者在正文里自己写了「本轮没写」「没有处理」, 不算掩饰。

---

## 四 测试与文档现状

```
$ npx vitest run      (code 0)
 Test Files  197 passed (197)
      Tests  1468 passed (1468)
   Duration  8.35s
```
- **全绿, 而且是正当的绿** (见三·3、三·4)。
- 用例数与上轮完全相同, 本轮新增代码零覆盖。
- `npx tsc --noEmit -p .` → code 0 (排除了两个面板前端文件, 见三·5)。
- `verify-docs.ts` → code 0。

**verify-structure (问 7):**
```
$ node --no-warnings scripts/verify-structure.ts      (code 1)
verify-structure: 发现 11 处结构问题:
  规模: src/adapters/codex/cli.ts 401 / dsh/index.ts 441 / dsh/runtime.ts 405 / dsh/tools.ts 440 /
        kernel/binder.ts 404 / kernel/ports.ts 414 / retrieval/hybrid.ts 423 / scripts/panel-server.ts 899 (上限 400)
  禁止模式: 可见性判定手写 shadow 出现在 src/app/kb-sync.ts
  悬空模块: src/app/kb-sync.ts 无法从任何产品入口到达
  悬空模块: src/coding/precipitate.ts 无法从任何产品入口到达
```
我对 HEAD 与工作区做了行数对比 (`git show HEAD:<f>` vs 磁盘):

| 文件 | HEAD | 工作区 | 来源 |
|---|---|---|---|
| codex/cli.ts | 401 | 401 | HEAD 既有 |
| dsh/index.ts | 439 | 441 | HEAD 既有, 本轮工作区又 +2 |
| dsh/runtime.ts / tools.ts / binder.ts / ports.ts | 405/440/404/414 | 同 | HEAD 既有 |
| retrieval/hybrid.ts | 417 | 423 | HEAD 既有, 工作区 +6 |
| scripts/panel-server.ts | 不存在 | 899 | **新引入** |
| src/app/kb-sync.ts (shadow + 悬空) | 不存在 | 289 | **新引入 (2 处)** |
| src/coding/precipitate.ts 悬空 | 213 | 213 | HEAD 既有 |

- 11 处里 8 处在 HEAD 已存在, `scripts/verify-structure.ts` 本身未改 → HEAD 上 `verify-structure` 就已经是红的。**3 处是未提交工作新引入的**: panel-server 899 行 (超上限一倍多)、kb-sync 手写 shadow 判定 (仓库自己的规则说这类写法实测漏判 merged/expired)、kb-sync 悬空。
- 影响结论吗? **影响一点, 不改变方向**:
  - `scripts/verify.sh` 第 69 行就跑 `pnpm run verify-structure`, 失败即 `exit 1`。所以「vitest 全绿」≠「仓库门禁全绿」, 完整门禁在第一步就停了。FIX-ROUND-1 写的是「它不在 vitest 里, 本轮没处理」, 措辞准确, 但读者容易把「全量测试全绿」读成「门禁全绿」。
  - **kb-sync 悬空才是要紧的那条**: 知识库同步模块从任何产品入口都到不了, 只能被评测脚本和面板调用。也就是说即使 K1/K2 将来达标, 它测的也是一个**没接进 DSH 的模块**。这直接削弱 Q2 (博客当知识库)。
  - 作者自己还指出 verify-structure 的参数属性检查正则有盲区 (只认带 `:` 的写法, 只扫 `src/` 与 `scripts/lib`)。属实的话, 上轮「不可复现」那类问题 gate 抓不住。没修。

**文档:**
- STATUS.md / DETECT-REPORT.md / model.ts 头注 / 面板 与实跑一致。
- FIX-ROUND-1.md 数字基本可信, 漏一行 (lesson 78), 且与当前 `memory-recall.ts` 输出不同步 (没有安慰剂行)。

---

## 五 结论

**分数: 3/10 → 4/10。现在仍不能接进工作流。**

这一轮的质量比上一轮好: 修的是真问题, 门槛是收紧的, 自述数字我几乎都复跑对上了, 坏结果 (A1 掉到 0.269、M2 代理 0.004) 也照实写了。但这些修复几乎全落在「评测与报告的可信度」上; 「这个记忆层接进去有没有用」的证据没有变多, 新增的那点证据还偏负面。

加回的分:
- **+1 可复现**: Node 26 上 kb-coverage / kb-retrieval / train / detect / concurrency 全部能起, 复现命令统一, tsc 干净。

保留的扣分 (共 -6):
1. **-2 没在用**: 插件关闭 536 小时, 线上加载的 dist 是旧构建, 不含之后所有 src 修复。没有任何真实负载证据。
2. **-2 检索有用性**: K1/K2 未测; 语义检索未启用 (仅 BM25 / LexicalEmbedder); 知识库 0 条且 `kb-sync.ts` 是悬空模块; 新的 M2 引用核对代理 strict 0.004 (安慰剂 0.000)、loose 0.249 (安慰剂 0.130) — 不是正式 M2, 但没有任何一个口径接近 0.40。
3. **-1.5 「骂人 → 评审 → 不再犯」**: 规则诚实了, 结果是 A1 0.269 (要求 0.90); 判官未配置; C1 n=0; C2/C3 脚本仍不存在 (这条不是「需要人」, 是没写)。
4. **-0.5 工程纪律**: 0 次提交 (本地 commit 无任何阻碍; 审计期间代码还在被改, 无基线可钉); `.hark-tmp/bf-trial1.json` 疑似密钥仍在且 `.hark-tmp/` 未忽略; 本轮新代码零单测; verify.sh 在 verify-structure 处红 (3 处新引入, 含 899 行的 panel-server 和 kb-sync 手写 shadow); tsconfig 把两个面板前端文件移出类型检查未说明。

**能不能接进工作流: 不能。** 要我改判, 最少需要 (按「不依赖他人 → 依赖用户」排序):
1. 现在就把工作区拆成可回滚的 commit, `.hark-tmp/` 进 `.gitignore`, 处理掉疑似密钥文件。(作者自己能做)
2. 写 `correction-effect.ts`; 给 `choose()`、`judge()`、`capture-check` 补单测; 修 kb-sync 的 shadow 判定与悬空接线。(作者自己能做)
3. 用户提供判官 key → 跑正式 M2 (判官 + 20% 人工复核) 和 C1。
4. 用户写 120 条问题 → K1/K2 有数。
5. 重建 dist 后重新启用插件, 稳定采集一两周, 用 `capture-check.ts` 和正式 M2 证明注入内容被用上 (≥ 0.40)。

存储层 (M5 6/6 次 400/400, 锁 / SIGKILL 测试通过) 依然是可靠底座, 这一点没变。
