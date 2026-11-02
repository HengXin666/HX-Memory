# MEMORY-DECAY.md — 采集 / 清库 / 衰减 / 沉淀质量 / 回填 (2026-11-02 22:30 CST 刷新)

每一项给 命令 + 退出码 + 原始输出。
**执行通道**: 2026-11-02 起有宿主 exec (`POST /fs/exec`, cwd = 仓库根)。本文件里标「宿主」的结果都是经 exec 在宿主上实跑的;
标「拷贝」的是在宿主上真实记忆根的拷贝 (`~/.dsh/hx-memory-bftrial-20261102`) 上跑的, 用来试回填而不碰真库。
所有命令都可以在仓库根用同一条命令复跑。

---

## 1. 采集停了 21 天: 根因

详见 `COLLECT-BROKEN.md`。一句话: **插件是用户 10 月在插件管理器里主动关掉的, 原因是「当时效果不好」。**
插件管理器「关闭」的语义是保留依赖、取消选择:
- `~/.dsh/profiles/web/package.json` 的 `dependencies` 里仍有 `@hengxin666/hx-memory`, 但 `dsh.profile.bundles` (11 项) 里没有它;
- 两份历史备份 (`package.json.bak-1790412977` 09-26, `.bak-purge-20261001`) 的 bundles 里都有它。

生效于 2026-10-11 06:44 ~ 07:03 UTC 的那次 DSH 重启:
- 停摆前最后一个会话 session-1911b5f4: 系统提示词里有 `memory_search / memory_save` 等 5 个工具, `plugin:hx-memory` 来源的消息 33 条;
- 停摆后第一个会话 session-c68a4d49 (10-11 07:03, 同一工作区): 两项都是 0。

不是 hook 没挂、不是报错被吞: 插件根本没被 import, 所以也没有任何报错。

面板据此把插件状态分三种, **已关闭标灰、写明原因、不报警**:

| state | 面板显示 | 判据 (`GET /api/hooks` → `plugin`) |
|---|---|---|
| `enabled-active` | 已启用且在采集 (绿) | 在 bundles 里, 且 24 小时内有 pre-step 或入库记录 |
| `closed-by-user` | 已关闭 (用户主动, 灰) + 关闭原因 | 依赖在, 不在 bundles 里 |
| `enabled-no-data` | 已启用但没有数据 (红, 异常) | 在 bundles 里, 但 24 小时内没有任何记录 |

关闭原因的默认文案「用户 2026-10 在插件管理器里主动关闭, 原因: 当时效果不好」, 可在 `panel.json` 的 `pluginCloseNote` 覆盖。
重新启用: `bash scripts/capture-repair.sh` 后重启 DSH (先备份 package.json, 再追加回 bundles, 构建 dist; 幂等)。

```
$ DSH_HOME=<profile 副本> bash scripts/capture-repair.sh --check ; echo exit=$?
[1/3] 现状: {"installed":true,"spec":"link:/home/hx/Loli/code/HXLoLis/components/HX-Memory","selected":false,"bundles":11}
exit=3
```

---


---

## 2. 清库: kb-purge --apply (宿主, 已执行, 用户已验收)

```
$ node --experimental-strip-types --no-warnings scripts/kb-purge.ts --apply
exit=0  (stderr 为空)
① 备份前: {"total":6045,"active":5959,"kb":4672,"fts":6045,"byKind":{"context":700,"decision":92,"fact":30,"lesson":440,"pattern":74,"preference":18,"rule":19}}
  备份快照: {"total":6045,"active":5959,"kb":4672,"fts":6045,"byKind":{"context":700,"decision":92,"fact":30,"lesson":440,"pattern":74,"preference":18,"rule":19}}
  ✓ 备份完成并核对: /home/hx/.dsh/hx-memory-backup-kbpurge-20261102
② 选中 4672 条 (source kb: 且 kind doc), 分布在 12 个真相文件; source kb: 但不是 doc 的 0 条不动
③ removeMany: {"found":4672,"blocksRemoved":4672,"mode":"hard","ms":11114}
④ 校验:
  ✓ kb 残留为 0  kb=0
  ✓ 对话沉淀逐 kind 不少  {"context":700,"decision":92,"fact":30,"lesson":440,"pattern":74,"preference":18,"rule":19} → {"context":700,"decision":92,"fact":30,"lesson":440,"pattern":74,"preference":18,"rule":19}
  ✓ FTS 行数 = memories 行数  fts=1373 memories=1373 孤儿=0
  ✓ tags/entities/relations.from 无孤儿  {"fts":0,"tags":0,"entities":0,"relationsFrom":0,"relationsTo":0}
  ✓ 真相文件里无 source: kb:  0 个文件
  ✓ 从真相重建后 doc 仍为 0 (不复活)  重建 total=1373 kb=0
⑤ panel.json 的知识库来源已清空 (原文件备份在 panel.json.bak)
⑥ 报告: /home/hx/.dsh/hx-memory-backup-kbpurge-20261102/kb-purge-report.md

✓ 全部校验通过
```

删后再查 (另一条 exec, 直接读 `~/.dsh/hx-memory/index.sqlite`, exit=0):
```
total 1373
kb 0
integrity ok
```

| | 删前 | 删后 |
|---|---|---|
| total | 6045 | 1373 (含 86 条 shadow) |
| active | 5959 | 1287 |
| kb (doc) | 4672 | 0 |
| FTS 行 | 6045 | 1373 |
| 对话沉淀逐 kind | context 700 / decision 92 / fact 30 / lesson 440 / pattern 74 / preference 18 / rule 19 | 相同 |

备份: `~/.dsh/hx-memory-backup-kbpurge-20261102` (含 kb-purge-report.md/json); 更早的 `…-20261101` 仍在。
副作用: 脚本把面板 `panel.json` 的知识库来源清空, 原文件在 `panel.json.bak`。

失败路径: 备份或备份核对失败 ⇒ `fail()` 打印「已停止; 记忆根未被修改」并 exit=1, 不会进入删除; 任一校验不过 ⇒ exit=1。

### 面板「清空知识库」按钮
`DELETE /api/kb/purge` (scripts/panel-server.ts) 只做两件事: ① 后端再校验一次确认词「清空知识库」(前端要求二次确认 + 手输); ② 以子进程跑**同一个** `scripts/kb-purge.ts --apply --root <记忆根> --backup <目录>`。没有第二套删除实现。
```
$ node -e "fetch('http://127.0.0.1:36100/api/kb/purge',{method:'DELETE'})…"   (不带确认词)
400 {"ok":false,"error":"需要确认词: 清空知识库"}
$ GET /api/kb/purge
200 {"ok":true,"data":{"job":null,"running":false}}
```
注意: 备份目录按 UTC 日期命名, 同一天再按会复用 `…-20261102`。

---

## 3. bulk-remove 入边孤儿

问题: hard 删除只清 `relations.from_id`。A 的真相块写着 `relates → B` 时, 删 B 只删索引行不够: 下次 `rebuildFromFiles` 会从 A 的块把这条边原样建回来, 而 B 已经不存在。

修法 (`src/storage/bulk-remove.ts` `detachIncoming`): 删 B 之前, 找出所有指向 B 的条目, 走 `update` 改写它们自己的 relations (真相 + 索引一起), 然后才删块、清索引。`removeMany` 与单条 hard `remove()` 同一判据。

用例 `tests/s2/bulk-remove.test.ts`「hard: 删 B 时摘掉 A→B 的入边 (真相 + 索引), 重建后也无悬空边」: removeMany 与单条 remove 各跑一遍, 删索引后从真相重建再断言。

```
$ npx vitest run tests/s2/bulk-remove.test.ts ; echo exit=$?
 ✓ tests/s2/bulk-remove.test.ts (3 tests) 393ms
 Test Files  1 passed (1)
      Tests  3 passed (3)
exit=0
```

> 这个修复 22:21 PUT 过一次, 之后被另一路写回了不含 `detachIncoming` 的版本; 22:50 重新 PUT (host md5 bulk-remove.ts 1bd95223 / file-store.ts c9998a21 / test e8cdcb84)。

---


---

## 4. 衰减

模型与参数由宿主那一路实现: `src/kernel/temporal.ts`, 推导与曲线见 `docs/temporal-decay.md`
(rule H=41 天, 地板 0.2; decision H=41, 地板 0.15; doc 保持 ∞; 同话题新条目把旧的压到 ×0.1 且不进常驻注入)。本轮补的:

### 4.1 时间衰减页 404
`GET /api/decay` 的路由在 `scripts/panel-server.ts` 里, 但正在跑的面板进程是在这条路由加进去**之前**启动的, Node 不热加载 ⇒ `no route`。**改了 panel-server.ts 必须重启面板。**

### 4.2 每条记忆真算打分
`/api/decay` 新增 `scored`: 全部 active 对话沉淀, 与线上排序同一套 temporal.ts 函数。时间衰减页新增「每条记忆的打分」表, 可按类型、来源筛选:

| 列 | 含义 |
|---|---|
| 断言日期 | max(validAt, confirmedAt) |
| 距今 (天) | now − 断言日期 |
| 半衰期 H / 地板 | `DECAY[kind]` |
| 保持率 R | floor + (1 − floor)·2^(−age/H) |
| 初始置信度 | 条目的 confidence, 空时 0.7 |
| 最终分 | 初始置信度 × R × (被同话题新条目压住 ? 0.1 : 1) |
| 来源 | 推导出的沉淀 / 用户原话 |

演练 (拷贝上的面板):
```
$ curl …/api/decay | jq '.data.scored | length'
1287
pattern 2026-10-04 28.2 60 0.15 0.764 0.92 False 0.703 推导出的沉淀 拒绝绕过 Cloudflare 批量注册 Typ
lesson  2026-10-06 26   60 0.15 0.78  0.9  False 0.702 推导出的沉淀 设置页新增「思考强度覆盖」卡…
context 2026-09-16 46   7  0.05 0.06  0.7  False 0.042 推导出的沉淀 argo 是 HX-Sagasu 唯一可用检索底…
```

---

### 4.3 衰减曲线表 (保持率 R = floor + (1 − floor)·2^(−age/H), 参数取自宿主 `GET /api/decay` 的 params)

| kind | H (天) | 地板 | 0 天 | 7 天 | 30 天 | 60 天 | 90 天 | 180 天 |
|---|---|---|---|---|---|---|---|---|
| event | 3 | 0 | 1.000 | 0.198 | 0.001 | 0.000 | 0.000 | 0.000 |
| context | 7 | 0.05 | 1.000 | 0.525 | 0.099 | 0.052 | 0.050 | 0.050 |
| lesson | 60 | 0.15 | 1.000 | 0.934 | 0.751 | 0.575 | 0.451 | 0.256 |
| pattern | 60 | 0.15 | 1.000 | 0.934 | 0.751 | 0.575 | 0.451 | 0.256 |
| fact | 45 | 0.15 | 1.000 | 0.913 | 0.685 | 0.487 | 0.362 | 0.203 |
| preference | 90 | 0.2 | 1.000 | 0.958 | 0.835 | 0.704 | 0.600 | 0.400 |
| decision | 41 | 0.15 | 1.000 | 0.905 | 0.662 | 0.458 | 0.336 | 0.191 |
| rule | 41 | 0.2 | 1.000 | 0.911 | 0.682 | 0.490 | 0.375 | 0.238 |
| doc | ∞ | 1 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 |

doc 不衰减 (知识库切片只在检索时按需返回, 不参与注入, 现在库里也已经是 0 条)。

### 4.4 confidence: 改动前后
- **改动前** (§765 之前): 结构化器不产 importance / confidence, 每条都落中性常量, 打分时按 0.7 算。
- **改动后**: LLM 结构化器按提示词给 confidence, `src/capture/structurer-io.ts` 解析并夹到 [0, 1] 后透传; 没给就仍是中性 0.7 (不编造)。

宿主真库现状 (active 1287 条, exec 读 index.sqlite, `python3 .hark-tmp/conf.py`, exit=0):
```
 null/set (972, 315)
  ('context', 663, 0.769, 0.65, 0.95, 395)
  ('decision', 69, 0.726, 0.7, 0.9, 59)
  ('fact', 24, 0.7, 0.7, 0.7, 24)
  ('lesson', 434, 0.703, 0.7, 0.9, 425)
  ('pattern', 71, 0.768, 0.7, 0.92, 43)
  ('preference', 17, 0.7, 0.7, 0.7, 17)
  ('rule', 9, 0.7, 0.7, 0.7, 9)
 buckets [(0.7, 5), (0.8, 146), (0.9, 164)]
```
(列: kind, 条数, 平均 confidence (空按 0.7), 最小, 最大, 空的条数。) 315 条带 LLM 给的 confidence, 集中在 0.8~0.9; 972 条是空 (= 0.7)。
启发式回填 (第 6 节) 新增的 82 条 confidence 全为空, 说明启发式不产这个字段。

---

## 5. 沉淀质量: 记忆页分池 + 质量总览

### 5.1 判据 (`src/app/memory-quality.ts`, 纯函数)
- lesson / decision / pattern / fact / preference / rule 一律算**推导出的沉淀**; doc 算**知识库切片** (不计入)。
- context 满足其一才算推导出的沉淀:
  - **A.** 内容就是结构化器给出的结论 (`structured.conclusion === content`)。只有 LLM 读完一轮并给出结论时, pipeline 才用结论替换原文, 是最硬的信号。
  - **B.** ≥ 40 字, 带提炼结构词 (根因 / 起因 / 改为 / 结论 / 确认 / 判定 / 决定 / 导致 / 实测 / 而非 / 「：」…), 且「你」「我」合计不超过 1 次 (第三人称陈述)。
- 其余 context 是**用户原话**, 细分: 不足 40 字 / 纯指令或附和 / 命令、链接、路径、终端输出 / 对助手说话的口吻 / 无结构原文。

为什么不直接用「≥ 40 字且有实质内容」: 有 128 条 > 40 字的 context 实际是长段原话 (「你这输出还是有问题啊! 为什么我说话说着说着…」), 只看长度会算成沉淀。
抽样核对 (每边随机 12~15 条): 判为原话的全对; 判为沉淀的 15 条里 1 条其实是原话 (结构化器把原话当成了结论, 如「显然这里说明文档是AI写的AI…」)。

### 5.2 质量总览 (真实记忆根拷贝, active 对话沉淀)
```
$ curl …/api/memory/quality | jq -r .data.verdict
1287 条对话沉淀里, 推导出的沉淀 960 条 (74.6%), 用户原话 327 条 (25.4%)。 context 663 条里 327 条是原话 (49.3%), 其中 ≤20 字的 83 条。
```

| kind | 条数 | 占比 | 沉淀 | 原话 | ≤20 字 |
|---|---|---|---|---|---|
| context | 663 | 51.5% | 336 | 327 | 83 |
| lesson | 434 | 33.7% | 434 | 0 | 10 |
| pattern | 71 | 5.5% | 71 | 0 | 1 |
| decision | 69 | 5.4% | 69 | 0 | 4 |
| fact | 24 | 1.9% | 24 | 0 | 1 |
| preference | 17 | 1.3% | 17 | 0 | 0 |
| rule | 9 | 0.7% | 9 | 0 | 2 |

原话按原因: 对助手说话的口吻 128 / 不足 40 字 121 / 命令、链接、路径 38 / 无结构原文 23 / 纯指令或附和 17。
(协调方给的「700 条 / 117 条 ≤20 字」含 shadow; 上表只算 active: context 663 条, ≤20 字 83 条。)

### 5.3 面板
- **记忆页**: 顶部「沉淀质量总览」(一句话结论 + 判据全文 + 四个数 + 分类表 + 原话原因分布);
  下面两栏「沉淀物 (最近 50 条)」与「原始对话 (最近 50 条)」(`GET /api/memory/recent?pool=derived|raw`)。
  每条显示: 来源 (推导出的沉淀 / 用户原话 / 知识库切片)、是否已提炼 (附命中的结构词, 如「禁止/改为/起因」)、长度 (≤20 字标「低质」)。
- 现有 context **一条没删**, 只做标记和展示。

### 5.4 「对的，更详细的」「傻逼」为什么被存成记忆, 以及改法 (已改)
**结论**: 是 capture 的兜底路径。用户一句短话 + 助手这一轮有实质产出 ⇒ 越过 context 过滤; 结构化器没给出结论 ⇒ 用户原话原样落盘。三处叠加:

不是「所有用户消息都存」, 是**结构化器给不出结论时的 fallback 保留原文**, 加上前面放行太宽:

1. 放行: `captureTurn` (`src/capture/engine.ts:263`) 里 `src/capture/engine.ts:331-334`
   `bypassContext = negative.hit || (!explicit && (interrogative || substantive) && hasAnswer)`; `substantive = hasSubstantiveOutput(input.answer, text)` 只看助手这一轮的产出, 不看用户那句话 ⇒「对的，更详细的」+ 一段长回答 = 越过 `shouldCapture` 的 context 过滤。
2. fallback: `CapturePipeline.enrich` (`src/capture/pipeline.ts:292`) 只在有结论时替换 content (`pipeline.ts:310` `...(conclusion ? { content: conclusion } : {})`), 否则保留原文; 异常分支 `pipeline.ts:324`「AI 失败 → 原样落盘」; 启发式结构化器 `canConclude: false`, 从不产结论。
3. 闸太窄: `CapturePipeline.run` (`pipeline.ts:94`) 的结论闸只对 `needsConclusion = isInterrogative(input.text)` (`pipeline.ts:106`) 生效, 陈述句 / 指令句没结论也落盘。

复现 (行号): `python3 .hark-tmp/show.py src/capture/engine.ts:328:336 src/capture/pipeline.ts:300:326`

「傻逼」单独说: 命中负面信号时走的是教训草稿 (`禁止…。改为: …` + 原话作证据), 正常不会以原话落 context; 库里以原话出现的, 是负面词典没命中的那几条 (或与别的需求拼在同一轮)。

**判据 (什么输入本该被拒)**: 拒绝 ⇔ 非负面信号轮次 ∧ kind = context ∧ `qualityOf(entry).origin === "raw"`。即 kind 为 context、结构化器没给出结论、且内容本身是用户原话 (不足 40 字 / 纯指令或附和 / 命令、链接、路径、日志 / 对助手说话的口吻 / 无提炼结构)。

**已改** (2026-11-02, `src/capture/pipeline.ts:145-162`「原话闸」): enrich 之后, 非负面轮次里 `kind === "context"` 且 `qualityOf(entry).origin === "raw"` 的条目不写入, 计入 `noConclusion`。判据与面板分池是**同一个函数** (`src/app/memory-quality.ts` `qualityOf`), 不另写一套。原文仍在 DSH 会话文件和 episode 里, 不丢。
- 新用例 `tests/s2/capture-review-queue.test.ts`「原话闸」: 「next all」「对的，更详细的」+ 400 字带根因的回答, 结构化器无结论 ⇒ 0 条入库。
- 旧用例「有产出但无结论 → 入库 + 进审核队列」改用一句自带提炼结构的陈述 (旧用的是「next all」, 正是该被拦的原话); 「先落盘、事后剔除」的契约本身不变。
- 现有 context 一条没删。

**没解决的部分 (第 6 节实测暴露)**: 原话闸只管 kind=context。启发式把原话推断成 decision / pattern 时 (如「对呀，你直接做，不要一直在这里提。」→ pattern), 它不拦, 而 `qualityOf` 对非 context 一律判为沉淀 ⇒ 面板「沉淀率」对这些条目是高估的。根本办法是有 LLM 结构化器 (给出结论才替换原文)。

---

## 6. 回填 10-11 至今

脚本 `scripts/backfill-sessions.ts`:
- **同一条链路**: 只把触发源换成会话文件, 落盘仍调 `flushTurn` (episode → CapturePipeline.run → FileBackend); 配对规则与 `HxMemoryRuntime.capture` 相同 (只收 `source.kind === "user"`, turn/end reason ∈ completed / max-tokens, 跳过 subagent 会话)。
- **occurredAt**: 回填传原始 turn/end 时间, 衰减起点不后移。
- **多帧 zstd**: 按帧魔数逐帧解, 与 `zstd -dc` 逐字节一致。
- **幂等**: 键 `sessionId#turn`, 记在 `<root>/backfill/done.jsonl`; 启动时读入 `capture/*.jsonl` 里在线捕获过的轮次。
- **损坏文件**: 解不开 / 没有 session 头 ⇒ 跳过, 记进 `unreadable` 与 `unreadableFiles`, stderr 打一行, 不中断 (2026-11-02 补的记账)。
- **质量闸**: 没配 LLM 且不加 `--allow-heuristic` ⇒ exit=2 拒绝运行。

### 6.1 全量回填 (拷贝, 2026-10-11 06:44 UTC 至今, 启发式, 两遍)
宿主面板的模型配置为空 (`GET /api/model`: base_url 空, has_key false), 没有可用的 LLM 凭据, 只能用 `--allow-heuristic` 试。为了不把可能的垃圾灌进真库, 先在拷贝上跑。

```
$ node --experimental-strip-types --no-warnings scripts/backfill-sessions.ts --root ~/.dsh/hx-memory-bftrial-20261102 --allow-heuristic --json .hark-tmp/bf-trial1.json
exit=0
files 1873 / sessionsInRange 216 / subagentSkipped 196 / unreadable 0 / turns 925 / alreadyDone 1 / replayed 924 / sessionsReplayed 215
before {lesson 434, context 663, decision 69, fact 24, preference 17, pattern 71, rule 9}
after  {decision 93, lesson 438, context 679, pattern 108, fact 25, preference 17, rule 9}
added  {decision 24, lesson 4, context 16, pattern 37, fact 1}  addedTotal 82   ms 74959

$ (同一命令第二遍)
exit=0
files 1873 / sessionsInRange 216 / subagentSkipped 196 / unreadable 0 / turns 925 / alreadyDone 925 / replayed 0 / sessionsReplayed 0
addedTotal 0  added {}
after  {decision 93, lesson 438, context 679, pattern 108, fact 25, preference 17, rule 9}   ms 70179
```
两遍 after 逐 kind 相同, 第二遍新增 0 ⇒ 幂等。原话闸生效: 924 轮里原话 context 被拦下, 只新增 82 条 (旧版同样的 8 个会话里 7/8 是原话)。

损坏文件 (一个好文件 + 一个伪造的坏 zstd, `--dry-run`, exit=0):
```
ERR   ! 跳过无法解析的会话文件 (zstd/头缺失): …/.hark-tmp/sess-test/b/session-bad/session.v4.jsonl.zstd
  "files": 2,
  "unreadable": 1,
  "unreadableFiles": [ "…/sess-test/b/session-bad/session.v4.jsonl.zstd" ]
```

### 6.2 人工抽 20 条 (82 条新条目里随机, seed 20261102)
判定标准: 脱离原对话, 下一次会话能直接照着用的结论 / 偏好 / 约束 = 值得入库; 需求原文、日志、吐槽、一次性指令 = 不值得。

| # | kind | 内容 (截 50 字) | 值得入库 | 理由 |
|---|---|---|---|---|
| 1 | decision | 指定**这一个**邮箱 (留空 = 自动挑)  你这个 一直都只有【自动挑选】  我无法选择！！你根… | 否 | 用户抱怨原话, 无结论 |
| 2 | pattern | 这个番剧页面你可能需要重新筛选一下，然后还有它那个tag，你可能也要再看一看  我的意思是前端的展示… | 否 | 多条需求原话拼接 |
| 3 | decision | cr的bug你让他修复一下  另外，再来一个任务，调研一下如何规范一下提 PR, 目前 PR 内容鱼… | 否 | 任务指令原话 |
| 4 | decision | 现在有1个非常奇怪的问题。我现在只希望除非我明确限定的要求，或者使用了这种agent预设，它才应该去… | 是 | 稳定偏好: 仅在明确要求/预设时用 hark |
| 5 | lesson | 工具调用hark_map · hk4y2ufi9p@loliko.top 思考 查看原文  配额用完… | 否 | 思考过程/工具输出, 非结论 |
| 6 | pattern | 为 node-maint 接入 https://github.com/hezhanleiok/gat… | 否 | 一次性任务指令 (含一条约束) |
| 7 | pattern | 对呀，你直接做，不要一直在这里提。 我们要求是做出1个完整可用的版本，而不是1个demo。 | 是 | 稳定偏好: 要完整可用版本而非 demo |
| 8 | context | 写一份 AI 代码审查方案，对象是 /home/hx/Loli/code/HXLoLis/compo… | 否 | 任务说明原文 |
| 9 | pattern | 傻逼！禁止走谷歌登陆 | 是 | 约束: 禁止走谷歌登录 (措辞是原话) |
| 10 | decision | hxk_***(已打码)  hx-pxy 连接 https://pxy.woa.qzz.io/  看… | 否 | 含疑似密钥 + 问题原文 (不该入库) |
| 11 | context | 协议注册呢  走 /hx-web-reverse 把过程都协议化 cf 必须点击，无法绕过 | 否 | 短问句+指令 |
| 12 | decision | 不行，重新设计，现在不再需要 sub hark 模式，也就是不需要 github 绑定了，直接工作区… | 是 | 决定: 不再要 sub hark 模式, 改工作区映射 |
| 13 | pattern | hark这个秘书，效率太低了，而且也不会维护上下文和并发  比如让 hark: plan -- ha… | 否 | 长段吐槽原文 |
| 14 | context | claud2api 注册，走浏览器模式，为什么浏览器总是： egress: c262ce2696d1… | 否 | 报错日志原文 |
| 15 | decision | switch to 主线，看看工作流为什么失败了 [plugin:vite:import-analy… | 否 | 报错日志+指令 |
| 16 | context | 傻逼。这些都直接拿官方源码就完事了，你就实现一个账号pool, 和他完全解耦的。其它禁止有任何dif… | 否 | 辱骂+一次性指令 |
| 17 | pattern | 是的，另外，侧边栏应该支持归档项目，目前侧边会话树还是和dsh有很大差距  侧边栏内容可以top栏，… | 否 | 多条 UI 需求原话 |
| 18 | context | 人类只需要活动一个仓库，然后修改资料（签名，名称，头像）+创建自己的仓库，然后开 2FA 就可以了，… | 否 | 观点原话, 无上下文 |
| 19 | decision | 你先审核一下，选择最优的。反正当前项目也没有完全启用，还是只是1个demo模式。所以你可以随意的修改… | 否 | 一次性指令 |
| 20 | pattern | https://linux.do/t/topic/3060731 你看看使用教程呢 不对。开原生 m… | 否 | 链接+指令原话 |

**合格率 4/20 = 20%, 低于 50% ⇒ 按约定停下, 没有回填到真库。** 真库 `~/.dsh/hx-memory` 仍是 total 1373 / active 1287, 未改动。

原因: 没有 LLM 时结构化器不产结论, content 就是用户原话; 原话闸拦掉了 context, 但启发式把同样的原话推断成 decision / pattern (24 + 37 条) 后照样入库。第 10 条还带着一串疑似密钥。这正是用户关掉插件时的老问题。
**要继续回填, 需要先给一个 OpenAI 兼容模型** (面板「模型」页保存后用 `--panel-config`, 或 `HX_BACKFILL_BASE_URL / HX_BACKFILL_MODEL / HX_BACKFILL_API_KEY`), 在拷贝上重跑这一节, 合格率 ≥ 50% 再对真库跑。

---

## 7. 面板重启与核验 (宿主)
面板进程由 systemd --user 托管 (`/proc/<pid>/stat` 的父进程是 `/usr/lib/systemd/systemd --user`), 杀掉旧 pid 57805 后由它拉起 pid 104799, 命令行 `node --experimental-transform-types --no-warnings scripts/panel-server.ts --port 36100 --dist .tmp/panel/dist`。手动起: `setsid nohup node --experimental-transform-types --no-warnings scripts/panel-server.ts --port 36100 --dist .tmp/panel/dist &`。前端: 服务优先发预构建单文件 `scripts/panel.dist.html` (比 panel-app.tsx 晚 4 秒生成, 本轮前端源码未改, 未重建)。HX-WebX 的 `start` 走 `bash scripts/panel.sh start` 会失败 (WebX 环境里的 node 不认 `--experimental-transform-types`), 不影响 systemd 那份。
```
GET /api/memory/list?pool=raw     200 total 327, 每条带 quality {length, low, refineMarks, origin, originLabel, refined, rawReason}
GET /api/memory/list?pool=derived 200 total 960
GET /api/memory/quality           200 verdict「1287 条对话沉淀里, 推导出的沉淀 960 条 (74.6%), 用户原话 327 条 (25.4%) …」
GET /api/hooks                    200 plugin.state closed-by-user, closeNote「用户 2026-10 在插件管理器里主动关闭, 原因: 当时效果不好 …」
GET /api/decay                    200 scored 1287
GET /api/kb/purge                 200 {job:null, running:false}
GET /                             200 HX-Memory 面板
```
后端出错时返回 `{ok:false, error}` (stackError 500 / 未捕获异常 500), 前端每页的 `useLoad` 把 error 交给 `<Err>` 显示原因。

前端字串核验 (`GET /` 返回的 HTML 里计数): 沉淀物 1 / 原始对话 1 / 沉淀质量总览 1 / 用户原话 4 / 推导出的沉淀 3 / 知识库切片 5 / 已提炼 1 / 清空知识库 3 / 已关闭 (用户主动) 1 / 已启用但没有数据 1 / 每条记忆的打分 1。
已关闭态: Alert variant default + `opacity-70`, Badge secondary (灰), 账本「N 小时前」在 closed 时用 secondary 不用 warning。

## 8. 测试
```
$ npx vitest run
 Test Files  1 failed | 196 passed (197)
      Tests  1 failed | 1467 passed (1468)
 FAIL tests/s1/docs-gate.test.ts (既有: AGENTS.md:4 与 docs/memory-four-timings-comparison.md:19 两处引用不存在)
```
