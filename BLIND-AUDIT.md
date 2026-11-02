# BLIND-AUDIT — HX-Memory 盲审

审阅时间: 2026-11-02 22:07–22:20 CST。全部结论来自本次经 `/fs/exec` 在宿主上亲自跑出的结果; 文档里的数字只当「待核对的宣称」。
宿主环境: `node --version` → `v26.12.0`。HEAD = `62ef9a7`。

> 副作用声明: 本次审计跑 `concurrency.ts` / `frustration-detect.ts` / `train-frustration.ts` 时, 脚本自己会重写 `eval-out/M5.json`、`eval-out/A1.json`、`eval-out/A2.json`、`eval-out/train.json` 和 `docs/eval-report.html`。另外在 `.hark-tmp/audit-probe.mjs` 放了一个面板探测脚本。除此以外没改任何文件。

---

## 一 逐条核对结果

验收标准位置: `PLAN.md` 第 0 节 (J1.1–J3.7) + 第 4 节 (判据 → EVAL 指标 → 脚本); 指标定义与阈值在 `EVAL.md`; 各阶段自评在 `P0-REPORT.md` / `P1-REPORT.md` / `P2-REPORT.md` / `DETECT-REPORT.md` / `KB-PURGED.md` / `REPORT-BUILD.md`; `AGENTS.md` 只有 agent-notes 红线, 没有功能验收标准。

| # | 宣称 (出处) | 实测命令 → 结果 | 一致? |
|---|---|---|---|
| 1 | J1.2 / M5 = 1.00: 两进程各写 200 条, 每次 400 条全可读 (P0-REPORT §2/§4) | `node --experimental-strip-types --no-warnings scripts/eval/concurrency.ts --procs 2 --each 200 --runs 5` → 10 次全部 `stored=400, writeErrors=[0,0], childCodes=[0,0]`, `M5 = 1.00 (threshold 1.00, runs 10)`, exit 0 | **一致** (只跑了 5×2 次, 不是 20×2) |
| 2 | tsc 无报错 (P0/P1) | `./node_modules/.bin/tsc --noEmit -p .` → exit 0, 无输出 | **一致** |
| 3 | J1.1 外置宿主默认关闭 (P0) | `grep -n HX_EXTERNAL_HOST ...` → `external-bridge.ts:34 return env.HX_EXTERNAL_HOST?.trim() === "1";`, `prestep-wiring.ts:58 const external = externalHostEnabled()` | **一致** (默认关; 但外置代码仍在仓库里, 只是开关关了) |
| 4 | 清库后 total=1373, kb=0, integrity ok (KB-PURGED §1.2) | 直接 `python3 sqlite3` 查 `~/.dsh/hx-memory/index.sqlite` → `total 1373 / kb 0 / ('ok',)`, byKind `context 700, decision 92, fact 30, lesson 440, pattern 74, preference 18, rule 19` | **一致** |
| 5 | `npx vitest run tests/s2` 127 文件 860 用例全过 (P0 §4) | 实测 `Test Files 128 passed (128) / Tests 864 passed (864)` | 基本一致 (数字略涨, 符合之后又加测试) |
| 6 | 全量 vitest 只剩 docs-gate 一条既有失败 (P1 §2) | 实测 `1 failed / 196 passed (197)`, `1 failed / 1467 passed (1468)`, 唯一失败就是 docs-gate | **一致** |
| 7 | 检测 A1/A2 (P1: 0.269/0.042; STATUS: B rules 0.365/0.063, 4 个候选; DETECT-REPORT: 选 B) | `node --no-warnings scripts/eval/frustration-detect.ts` → `A1=0.365 A2=0.063 n=196`, exit 2 (样本 < 600, 无 kappa)。`train-frustration.ts` 现在输出 **5 个候选 A–E, 选型是 E** (`recall 0.442, fpr 0.083 [0.046,0.133]`); 面板 `/api/health` 报 `model: linear-1`, `/api/detect` 报 `candidate: "E"` | **不一致**: STATUS 和 DETECT-REPORT 写的选型 (B, 4 候选) 已过期, 线上跑的是 E。E 的 FPR 0.083 **超过 J3.1 自己的 A2 ≤ 0.05 阈值**, 召回 0.442 远低于 0.90 |
| 8 | K3 = 1.00 (1022/1022 文件, 4672 切片) (P2) | `node --no-warnings scripts/eval/kb-coverage.ts --src ...` → **exit 1, `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`** (`src/app/kb-sync.ts:154` 的构造参数属性)。报告给的 `--experimental-transform-types` 在 node 26 上是 `node: bad option` (exit 9) | **无法复现**。K3=1.00 只能看 2026-11-01 留下的 `eval-out/K3.json` |
| 9 | K3 分母 (K3.json: ai-docs 44 篇) vs 语料 | 现在磁盘上 ai-docs 有 228 篇 `.md`, 其中 140 篇在隐藏目录 `.hx-staging` (按设计跳过), 剩 **88** 篇非隐藏; K3.json 只记了 44 | **对不上**, 原因未能确认 (可能是 11-01 之后新增, 也可能漏扫); 脚本跑不起来, 无法判定 |
| 10 | J2.3 K1/K2 (检索命中) | `kb-retrieval.ts` 同样 exit 1 (同一个 strip-only 报错)。P2 自己承认 120 条问题全空, K1/K2「未测」; `wc -l kb-queries.jsonl` = 120 行槽位 | 自述「未测」**属实**, 判据未满足 |
| 11 | J1.3 / J1.5 / J3.4–J3.7 所需脚本 `memory-recall.ts` / `injection-utility.ts` / `correction-effect.ts` (PLAN §4) | `ls scripts/eval` → 这三个文件**不存在** | 判据 **未开工** |
| 12 | C1 (教训质量) | `eval-out/C1.json` → `pass:false, n:0` | 自述「无值」**属实**, 未满足 |
| 13 | 每阶段单独提 PR 并附退出码 (PLAN §2) | `git log` 最新仍是基线 `62ef9a7`; `git status` 有 25 个已修改 + 大量未跟踪文件 (src/frustration/、src/storage/file-lock.ts、全部报告、面板脚本) | **不一致**: 0 次提交, 所有 P0–P2 工作都是未提交的工作区改动, 还混着 `*.bak-20261102-*` 备份文件 |
| 14 | 报告里的复现命令可直接跑 (P1 §4: 「运行方式 `--experimental-transform-types`」) | 宿主 node v26.12.0: `node: bad option: --experimental-transform-types`, exit 9 | **不一致**: P0 写的是 Node v22.23.3 环境, 现在宿主换了 node, 文档里所有 transform-types 命令全部失效, 依赖构造参数属性的脚本 (kb-coverage / kb-retrieval / kb-sync) 在 v26 下没有任何可用的跑法 |

PLAN 第 0 节三问的状态 (按它自己的判据):
- Q1 接入 DSH 当记忆: J1.1 ✓ J1.2 ✓ / J1.3、J1.4(A3)、J1.5 无脚本 → **不满足**
- Q2 博客当知识库: K3 曾达标但不可复现; K1/K2 未测; 知识库已被清空 (见二) → **不满足**
- Q3 骂人 → 评审 → 不再犯: A1 0.442 < 0.90, A2 0.083 > 0.05, C1 n=0, C2/C3 无脚本 → **不满足**

## 二 面板可访问性逐页结果 (127.0.0.1:36100)

探测方式: 宿主上 `node .hark-tmp/audit-probe.mjs` (fetch 每个路由)。`/api/health` 返回 `startedAt 2026-11-02T14:07:42.910Z` — 面板是在本次审计开始那一秒才起来的。

| 页 / 路由 | 状态码 | 返回内容 | 判定 |
|---|---|---|---|
| `/` `/index.html` `/proxy/hx-memory-panel/` | 200 | 504,924 字节单文件 React 页 | 可用 |
| `/api/health` | 200 | `{"ok":true,"port":36100,"memoryRoot":"/home/hx/.dsh/hx-memory","model":"linear-1"}` | 可用 |
| 总览 `/api/overview` | 200 | 对话沉淀 1287 条 (lesson 434, context 663…), kb total **0**, kb files 1022 / ingested 0 | 真数据; 1287 vs sqlite 1373 的差 86 = shadow 条目, 口径说得通 |
| 记忆 `/api/memory/recent` `/list` `/banks` | 200 | 真实条目 (如 `main:HX-Jungle` 的 lesson, 时间 2026-10-11T06:44:54Z) | 可用; 但最新一条就是 10-11 |
| 记忆 `/api/memory/search?q=记忆` | 200 | 有命中, `degraded: ["semantic:no-embedder (回退 词/bigram 覆盖率)"]` | 可用, **语义检索未启用**, 只有 BM25 |
| 记忆 `/api/memory/quality` | 200 | context 663 条里 raw 327 (**rawShare 49.3%**), low 101 | 真数据, 但说明一半 context 是未提炼的原话 |
| 时间衰减 `/api/decay` | 200 | 535 KB, 参数表 + 曲线 | 可用 |
| 知识库 `/api/kb` | 200 | `ingestedFiles 0, slices 0, state "未入库"` | **空数据**。这是用户选择「清空知识库 (B)」后的结果, 不是 bug, 但按标准: 这页现在没有可查的内容 |
| 知识库 `/api/kb/files` (不带 root) | 404 | `没有这个来源` | 缺参数的正常 404, 不计为缺陷 |
| 知识库 `/api/kb/purge` | 200 | `job:null` | 可用 |
| Hook `/api/hooks` | 200 | `state: "closed-by-user"`, `lastCaptureAgeHours 535.4`, verdict「已关闭 (用户主动), 不采集」 | 页面可用; **系统本身 22 天没采集** |
| 检测 `POST /api/detect` | 200 | 「你又搞错了，我说的不是这个」→ hit, score 1.897; 「帮我kill掉这个进程, 顺便看下垃圾回收」→ 不命中 | 可用, 技术词豁免生效 |
| 评估 `/api/eval` | 200 | 回归集现场重跑, 列出 r01… pass | 可用 |
| 模型配置 `/api/model` | 200 | `base_url "", model "", has_key false` | **空配置**: 判官 / 评审用的 LLM 没配, 所以同轮评审 (J3.2–J3.4) 在宿主上实际跑不起来 |
| 未知路由 `/api/nonexistent` | 404 | `no route` | 正常 |

结论: 路由层面全部能通、数据是真库里来的; 但「知识库」页为空、「模型配置」页为空、「Hook」页显示插件已关 22 天。按「有空数据就是没做完」的标准, 面板**没有完全做完**。

## 三 测试结果原文

命令: `npx vitest run` (宿主, cwd = 仓库根)

```
 Test Files  1 failed | 196 passed (197)
      Tests  1 failed | 1467 passed (1468)
   Start at  22:08:23
   Duration  7.88s (transform 8.51s, setup 0ms, collect 62.31s, tests 30.70s, environment 61ms, prepare 23.81s)

 FAIL  tests/s1/docs-gate.test.ts > verify-docs > 当前文档树通过 (引用可达 + 三要素齐全)
Error: Command failed: node --experimental-strip-types scripts/verify-docs.ts
verify-docs: 发现 2 处问题:
  AGENTS.md:4  引用不存在: .agents/notes/...md
  docs/memory-four-timings-comparison.md:19  引用不存在: /tmp/up/upstream-memory-playbook.md
```

失败是真失败, 但性质是文档门禁: `AGENTS.md:4` 里把字面 `.agents/notes/...md` 当成了引用, 另一处引用 `/tmp/up/...` 这种临时路径。与功能无关, 但它让全量测试**从来没有绿过**, 报告里一直以「既有问题」挂着没修。

补充: `npx vitest run tests/s2` → `Test Files 128 passed (128) / Tests 864 passed (864)`。

注意: 1468 条单测全过不等于判据达标 — 单测覆盖的是存储、锁、去重、闸门等单元行为, PLAN 的 J 判据要求的是真实数据上的评测脚本, 那部分大多没有或不达标。

## 四 伪造与夸大的证据

**没有发现伪造数字。** 能复跑的 (M5、tsc、sqlite 计数、A1/A2、vitest) 都和报告对得上或可解释。各报告对未达标项 (A1、K1/K2、C1、样本不足 600) 大多是自己承认的, 这一点值得肯定。

发现的是**过期、不可复现和口径夸大**:

1. **选型文档过期**: STATUS.md 写「4 candidates … B rules 0.365/0.063」, DETECT-REPORT 写「B rules 入选」。实跑:
   ```
   $ node --no-warnings scripts/eval/train-frustration.ts
   E rules + 词表兜底 (B ∪ A): recall 0.442 boot[0.268, 0.615]  fpr 0.083 boot[0.046, 0.133]  TP23 FN29 FP12 TN132  回归 15/15
   选型: E — FPR bootstrap 区间覆盖 0.05 的候选按留出召回排序, E 最高 (召回 0.442, FPR 0.083 [0.046, 0.133])
   ```
   面板 `/api/detect` 返回 `"candidate":"E"`。线上模型的点估计 FPR 0.083 高于 A2 ≤ 0.05; 「区间覆盖 0.05 就保留」是把阈值放宽后的自定规则 — DETECT-REPORT 自己也写了「若字面读…四个候选全部淘汰」。这是**降低门槛**, 不是达标。
2. **复现命令失效**:
   ```
   $ node --experimental-transform-types --no-warnings scripts/eval/frustration-detect.ts
   node: bad option: --experimental-transform-types        (exit 9)
   $ node --no-warnings scripts/eval/kb-coverage.ts --src /home/hx/Loli/code/HXLoLis/HXLoLi --out .hark-tmp/audit-k3
   SyntaxError [ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX]: TypeScript parameter property is not supported in strip-only mode
     at src/app/kb-sync.ts:154  constructor(private readonly opts: KbSyncOptions)   (exit 1)
   ```
   P2-REPORT 声称 K3=1.00 / exit 0, 当前宿主上没有任何办法复现。
3. **「用户复跑」口径**: P0/P1 的第 4 节写「以用户在真仓库上的复跑结果为准」, 即作者自己没在宿主上跑, 而是转述。本次复跑的几条恰好对得上, 但这种写法本身不是证据。
4. **K3 分母**: K3.json 记 ai-docs 44 篇; 当前非隐藏 ai-docs 88 篇 (另有 140 篇在 `.hx-staging` 被按设计跳过)。11-01 之后是否新增无法确认, 列为疑点不定性。
5. **「每阶段一个 PR 附退出码」没做**: `git log -1` 仍是基线 `62ef9a7`, 全部改动未提交, 工作区里还躺着 `scripts/backfill-sessions.ts.bak-20261102-since`、`src/capture/pipeline.ts.bak-20261102-gate` 等备份文件。
6. **docs-gate 一直红**: 全量测试从 P0 起就从未全绿, 每份报告都用「既有问题, 与本次无关」带过, 两行文档修复一直没做。

## 五 结论

**现在不能当记忆层用, 我不会把它接进自己的工作流。评分: 3 / 10。**

能用的部分 (加分):
- 存储层是认真的: 跨进程锁 + fsync + rename, M5 实测 10/10 次 400/400, SIGKILL 测试也过。sqlite integrity ok, 真相文件可重建。
- 测试量大 (1468 条) 且几乎全绿, tsc 干净。
- 面板路由全通, 数据来自真库, 不是假数据。
- 报告对很多未达标项坦白承认, 没有编数字。

扣分点:
1. **-2 没在用**: 插件 2026-10-11 起就被关掉 (面板自己报 `closed-by-user`, 535 小时无采集), 原因写的是「当时效果不好」。一个记忆层 22 天零采集, 等于没有在真实负载下被验证过。
2. **-2 检索质量未知**: K1/K2 一条都没测 (120 条问题是空的), 召回有用率 (M2/J1.5) 连脚本都没有; 语义检索 `no-embedder` 退化成纯 BM25; 知识库已被清空。我无法知道接进去后它注入的东西有没有用 — 而 PLAN 自己引用的旧审计是 1.4%–22.4%。
3. **-1.5 「骂人 → 评审 → 不再犯」没闭环**: 检测召回 0.442 (要求 0.90), 误报 0.083 (要求 ≤ 0.05), 评审用的 LLM 在面板里是空配置, C1 n=0, 复发率 C2/C3 和重放器没有。核心卖点之一完全没达标。
4. **-1 不可复现**: 宿主 node 换到 v26 后, 报告里的复现命令全部 `bad option`, kb 相关脚本彻底跑不起来。
5. **-0.5 工程纪律**: 0 次提交、备份文件混在工作区、docs-gate 长期红、STATUS/DETECT-REPORT 与线上模型不一致。

要我接, 至少需要: (a) 插件重新启用并稳定采集一两周; (b) K1/K2 用人写的问题跑出数字; (c) 一个能跑的 M2 召回有用率评测且 ≥ 0.40; (d) 所有评测脚本在当前 node 上能直接跑; (e) 改动提交成可回滚的 commit。存储层可以当底座留着, 上面的「记忆是否有用」目前没有任何证据。
