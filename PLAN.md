# HX-Memory 重构计划 (PLAN)

基线: `62ef9a7`。本文件只做计划, 不改任何代码。缺陷编号 (D1–D17) 见 `REVIEW.md`。

## 0. 三个问题的结论

| # | 问题 | 现在能不能用 | 重构后要满足的判据 (全部满足才算能) |
| --- | --- | --- | --- |
| Q1 | 接入 DSH 当记忆系统 | 不能 | J1.1–J1.5 |
| Q2 | 把博客目录挂成知识库 | 不能 | J2.1–J2.5 |
| Q3 | 检测到骂人后用新上下文评审并沉淀经验, 下一次不再犯 | 不能 | J3.1–J3.7 |

### Q1 接入 DSH 当记忆系统: 不能

依据:
- 仓库里有两条记忆链路同时挂在 DSH 上。一条是原生 FileBackend 链路 (`src/adapters/dsh/index.ts`), 另一条是外置宿主链路, 由 `src/adapters/dsh/prestep-wiring.ts:55-59` 在 `wirePrestepAndCapture` 里无条件挂上 `attachExternalHost`。两条链路各自检索、各自写入、各自检测挫折, 没有任何开关 (`grep -n "enabled\|HX_" src/adapters/dsh/external-bridge.ts` 退出码 1)。
- 外置链路有 D1 (bundle 并发写坏)、D3 (启动失败后整个进程不可用)、D4 (每个 step 重复写入)、D12 (读写不在同一个 bank)。
- 原生链路有 D17 (跨进程丢更新, `src/storage/markdown-codec.ts:144-147` 自己标明未修)。审计记录的召回有用率是 1.4%–22.4% (`docs/memory-failure-audit-20261006.md:118`)。

判据:
- J1.1 DSH 里只剩一条记忆链路。另一条删除, 或者降级为离线工具。
- J1.2 两个 DSH 进程共用同一个记忆根, 各写 200 条, 跑 20 次, 每次都是 400 条全部可读, 零损坏 (相当于对新存储层重跑 `REVIEW.md` 附录 A.2)。
- J1.3 启动时引擎不可达、之后恢复: 同一进程内检索恢复可用, 并有测试覆盖。
- J1.4 一轮里不管有多少个 step, 一条用户消息最多触发一次写入和一次反思。
- J1.5 有召回有用率评测并接入 `scripts/verify.sh`: 用回放集合计算「注入的条目被下一轮引用或遵守」的比例, 低于阈值 CI 失败 (阈值由用户定, 计划默认 ≥ 40%)。

### Q2 把博客挂成知识库: 不能

依据:
- 原生链路有现成的编译脚本 `scripts/kb-index.ts`: 把 Markdown 目录按 `##` 切片, 写成 `kind: "doc"` (`src/kernel/types.ts:21`); 没有 `hxid` 时按路径哈希生成 id (`scripts/kb-index.ts:42-43` 段)。但它只能手动运行。命令 `grep -rn "kb-index" src` 唯一的匹配是 `src/trigger/always-on.ts:152` 的一行注释, 说明没有自动同步, 没有文件监听, 也不处理删除。
- 外置链路的 `knowledge_search` 工具 (`src/adapters/dsh/external-bridge.ts:128`) 没有任何数据来源: `syncDocs` 在生产代码里没有调用方 (D14)。
- 博客常见的内容 (frontmatter 里的 title/date/tags、图片、MDX/HTML) 只能当正文切片, 图片不会入库 (`grep -n "png\|assets" scripts/kb-index.ts` 退出码 1)。
- 博客源已读取 (2026-11-01, 只读映射, HTTP 200): 这是一个 Docusaurus 站点, 内容在 `blog/`、`ai-docs/`、`docs/` 三个目录, 共 1213 个 `.md` 文件 (blog 43, ai-docs 233, docs 937), 没有 `.mdx`。数字由用户在本机 `find` 得出。`docs/.hark-bak/` 是写入通道的备份目录 (里面是 2 个占位文件), 不属于语料, 建 `corpus.lock` 时必须排除, 判定口径是 `find blog ai-docs docs -name "*.md" -not -path "*/.hark-bak/*"`。格式结论: Docusaurus 的 frontmatter (title/slug/tags/draft) 和 `##` 小节, 现有 `scripts/kb-index.ts` 的切法能处理; 语料里没有 MDX 组件, 图片不入库, 这两点暂时不影响 K3。

判据:
- J2.1 配置一个博客目录后, 新建、修改、删除文章能在一个可配置的时间窗口内 (默认 60 s) 反映到检索结果里, 不需要手动跑脚本。
- J2.2 用你博客的真实目录全量建索引: 每篇文章至少产出 1 条切片, 失败清单为空, 或者逐条列出原因。
- J2.3 回放集: 从你博客里构造 120 个「问题 → 应该命中的文章」样本 (EVAL.md 2.2), top-5 命中率 ≥ 80% (K1), MRR@10 ≥ 0.60 (K2)。
- J2.4 检索结果带文章路径 (或 URL) 和小节标题, agent 能引用到原文。
- J2.5 知识库只读: 不参与记忆的自动注入和衰减 (保持 `scripts/kb-index.ts` 头注释里的现有约定)。

### Q3 骂人触发新上下文评审并沉淀经验: 不能

依据:
- 关键词检测本身是能用的: 原生链路有词表加可选判官 (`src/adapters/dsh/negativity-wiring.ts` 头注释第 1-3 点), 负面轮次的经验提炼会把完整对话流喂给一次独立的 LLM 调用 (`src/adapters/dsh/llm-structurer.ts:59` 的 `isLesson` 分支, 通过 `agentSummarize` 调用)。这部分最接近你的需求。
- 不能用的原因有五条:
  1. 评审只在轮末捕获时发生, 不是检测到的当下 (`src/capture/engine.ts` 的捕获流程), 被骂的这一轮里 agent 拿不到评审结论。
  2. 评审调用的上限是 `timeoutMs: 10000`、`maxTokens: 1024` (`src/adapters/dsh/llm-structurer.ts:74-75`)。完整对话流一长就超时, 超时后退回模板禁令 (`src/kernel/negativity-lesson.ts` 的 `BEHAVIOR_BANS`), 而那正是审计里写的「沉淀了但没内容」。
  3. 外置链路又实现了一遍挫折检测和反思, 只拿那一句骂人的话当上下文 (D13), 每个 step 重复跑 (D4)。两套沉淀结果互不知道对方。
  4. code-task-precipitate 没有接入 (D15), 而且会把正常的修 bug 指令误判为纠正 (D16)。
  5. 「下次不再犯」没有任何度量: 审计记录里, 抱怨之后 agent 调用记忆工具的比例只有 3.5% (`docs/memory-failure-audit-20261006.md:34-45`)。仓库里没有「同类错误复发率」指标。
- 用 DSH 本地会话记录重放: 现有的重放只针对 HX-Memory 自己的 episode 日志 (`src/app/rebuild.ts:101-102`, `cli.ts rebuild --episodes`), 插件装好之前的 DSH 原生会话没有导入器。

判据:
- J3.1 检测: 用你真实会话里的 600 条用户消息 (EVAL.md 2.3, 人工标注骂人或纠正) 做评测集, 召回率 ≥ 90%, 误报率 ≤ 5%。技术词 (滚动条、垃圾回收、`kill`) 不能误报。
- J3.2 触发: 命中后在同一轮内 (不是轮末) 启动一次独立上下文的评审。输入是触发前 N 轮的完整对话加最近一次 diff, 一条消息只触发一次。
- J3.3 评审产出固定结构: 「错在哪 (文件或符号) / 用户真正想要的做法 / 适用范围 (仓库、目录、任务类型) / 证据 (原话、对话轮号)」。没有证据就不入库, 不能退回模板句。
- J3.4 评审结论在同一轮的下一个 step 就注入给主 agent, 主 agent 在这一轮内改正。
- J3.5 沉淀的规则按适用范围在后续会话里自动注入, 不依赖 agent 主动调用工具。
- J3.6 重放: 提供 `replay --dsh-sessions <目录>`, 把 DSH 历史会话按时间回放, 走同一条检测、评审、沉淀链路。结果幂等: 跑两遍, 规则数不变。
- J3.7 效果: 用历史会话做离线评测, 规则生效后在后续会话中, 同类纠正的复发次数下降 ≥ 50% (以重放前为基线)。

## 1. 重构方向 (交给实现方)

1. **只保留一条链路**: 以原生 FileBackend 链路为底座, 因为它有原子写、fsync、跨进程测试。外置宿主 (`src/external/*`, `src/adapters/dsh/external-bridge.ts`) 先从 DSH 卸下, 远端引擎改成可选的检索加速层, 而且必须先修掉 D1、D5 才能重新接回。
2. **存储层**: 补上跨进程写锁, 修掉 D17。canonical bundle 改成按条目存文件或 append-only 日志, 去掉整包读写 (D2)。
3. **挫折链路合并成一条**: 检测 (词表 + 判官 + 技术词豁免) → 按 消息id 去重 → 同轮独立评审 (J3.2–J3.4) → 规则入库 → 按适用范围注入。code-task-precipitate 的「决定表」并入这条链路, 当作规则的数据结构, 不再单独存在。
4. **知识库**: 把 `scripts/kb-index.ts` 改成常驻同步器 (监听文件变化加增量 sha256), 支持删除, 补上 frontmatter 元数据, 检索结果带出处。
5. **重放器**: 新增 DSH 原生会话导入器, 复用 `src/app/rebuild.ts` 的幂等重放。
6. **评测加入 CI**: J1.5、J2.3、J3.1、J3.7 四个评测进入 `scripts/verify.sh`, 评测集放在 `tests/fixtures/`, 敏感内容先用 `scripts/purge-secrets.ts` 脱敏。

## 2. 顺序与交付物

| 阶段 | 内容 | 完成标志 |
| --- | --- | --- |
| P0 | 卸下外置链路, 修存储并发 (D1/D17) | J1.1、J1.2 |
| P1 | 合并挫折链路, 同轮评审 | J1.4、J3.1–J3.5 |
| P2 | 知识库同步器 | J2.1–J2.5 |
| P3 | 重放器加效果评测 | J3.6、J3.7、J1.5 |
| P4 | 远端引擎作为可选加速层重新接回 | J1.3, 加上 `REVIEW.md` 第 8 节第 5 条 |

每个阶段单独提一个 PR, 每个 PR 都要附上对应判据的命令和退出码。

## 3. 真实数据来源 (已核实, 只读)

- 博客: `/home/hx/Loli/code/HXLoLis/HXLoLi`, 只读 `blog/`、`ai-docs/`、`docs/` 三个目录。共 1213 个 `.md` 文件, 排除 `.hark-bak/`, 明细见 Q2 依据。这是 K1–K4 测试集的语料。
- DSH 会话记录: `/home/hx/.dsh/sessions`, 共 29 个桶, 每个工作目录一个桶, 桶名是路径把 `/` 替换成 `-` 再两头加 `--`。每个会话是一个目录 `session-<uuid>/`, 里面有 `session.lock` 和 `session.v3.jsonl.zstd` (zstd 压缩的 JSONL)。抽样: HX-Memory 这个桶有 59 个会话, 抽到的那个会话压缩后 175,014 字节。这是 M1、M2、A1–A3、C1–C3 测试集的语料。DSH 原生会话导入器 (J3.6) 的读取格式就是 `session.v3.jsonl.zstd`; 解压后每行的 schema 要在 P3 开工时先取 1 个会话解压确认, 本计划不预设字段名。
- 评测设计、阈值和退出码约定全部见 `EVAL.md`。可视化报告是 `docs/eval-report.html`。

## 4. 判据和指标对照 (J 对应 EVAL.md 的指标 ID)

每条判据只用表里列出的指标来判定。对应脚本的退出码为 0, 这条判据才算满足。

| 判据 | 内容 (简写) | 指标 | 脚本 (待建, 见 EVAL.md 第 1 节) |
| --- | --- | --- | --- |
| J1.1 | DSH 里只剩一条记忆链路 | M1、M2 只在这一条链路上测 (EVAL F7: 必须经过 `prestep.ts` 入口) | `memory-recall.ts`, `injection-utility.ts` |
| J1.2 | 两个进程共写 400 条, 0 损坏 | M5 = 1.00 | `concurrency.ts --procs 2 --each 200 --runs 20` |
| J1.3 | 启动时引擎不可达, 之后恢复可用 | M1 (恢复后重测) 加 M4 (远端阈值) | `memory-recall.ts --engine-outage-at-boot` |
| J1.4 | 一条消息最多触发一次写入和反思 | A3 = 1 | `frustration-detect.ts --replay` |
| J1.5 | 召回有用率进入 verify | M2 ≥ 0.40, 加上 M3 = 0 | `injection-utility.ts`, `memory-recall.ts` |
| J2.1 | 新增、修改、删除 60 s 内生效 | K4 | `kb-sync.ts` |
| J2.2 | 全量建索引, 失败清单为空 | K3 = 1.00 | `kb-coverage.ts --src <博客根>` |
| J2.3 | 真实问题检索命中 | K1 ≥ 0.80, K2 ≥ 0.60 (集合规模按 EVAL 2.2 定为 120 条, 替代原来的 30 条) | `kb-retrieval.ts` |
| J2.4 | 结果带路径和小节标题 | K1 的小节级命中 (`expect_heading`) | `kb-retrieval.ts` |
| J2.5 | 知识库只读, 不参与注入和衰减 | M2 的注入条目里 `kind: "doc"` 的数量 = 0 | `injection-utility.ts --assert-no-doc` |
| J3.1 | 骂人检测准确 | A1 ≥ 0.90, A2 ≤ 0.05 (集合规模按 EVAL 2.3 定为 600 条, 替代原来的 200 条) | `frustration-detect.ts` |
| J3.2 | 同轮触发, 只触发一次 | A3 = 1 | `frustration-detect.ts --replay` |
| J3.3 | 评审产出固定结构, 有证据 | C1 ≥ 0.70 | `lesson-quality.ts` |
| J3.4 | 同轮下一步就改正 | C3 ≥ 0.60 | `correction-effect.ts --same-turn` |
| J3.5 | 规则在后续会话里自动注入 | M2 (只算规则类条目) | `injection-utility.ts --kind rule` |
| J3.6 | DSH 历史会话重放, 结果幂等 | C1 跑两遍, 规则数之差 = 0 | `correction-effect.ts --replay --twice` |
| J3.7 | 同类错误复发减半 | C2 ≥ 0.50 (EVAL F3、F4 两条反例检查要先通过) | `correction-effect.ts` |
