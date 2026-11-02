# HX-Memory 62ef9a7 上线评审

**结论: 不能大规模应用。** 理由是有 5 条阻塞缺陷 (D1–D5)。其中 D1 能稳定复现: 多进程共写一个 bank 时, canonical bundle 会被写成非法 JSON, 整个 bank 从此读不出来。

## 0. 评审对象与验证方式

- 代码: 映射目录 `/home/hx/Loli/code/HXLoLis/components/HX-Memory`, 调用方声明的检出是 `62ef9a7` (Merge PR #4 code-task-precipitate), 工作区干净。本评审没有执行 git。
- 阅读范围: `src/` 全部, `tests/` 全部, `.agents/notes/`, `docs/external-engines.md`, `docs/memory-failure-audit-20261006.md`, `scripts/verify.sh`, `.github/workflows/ci.yml`。
- 运行环境: 把映射目录的源码原样拉到独立环境 (Node v22.23.3, `node_modules` 按仓库 `package.json` 安装)。下面「命令 + 退出码」都是在这份拷贝上跑出来的结果。复现脚本全文见附录 A, 把它放到仓库根目录的 `.tmp/` 下就能在本机重跑。
- 跑过的现有测试: `npx vitest run tests/coding tests/s1/external-engines.test.ts tests/s1/external-host.test.ts tests/s1/external-perf.test.ts`, 退出码 0, 4 个文件 20 个用例全部通过。全量 `npx vitest run` 在 110 s 超时被中断 (退出码 124), 中断前已完成的文件全部通过。本评审对全量套件不下结论。
- 现有测试都通过, 但这不等于能上线: 第 6 节逐条说明, 下面这些缺陷没有一条被现有测试覆盖。

## 1. 判定依据 (阻塞项一览)

| 编号 | 模块 | 一句话 | 证据 |
| --- | --- | --- | --- |
| D1 | canonical bundle / 并发 | 两个进程同时写同一 bank, bundle.json 被写坏, bank 永久不可读 | 附录 A `r2-race.ts`, 连续 4 次运行 4 次复现 |
| D2 | canonical bundle / 规模 | 每次写入、每个召回命中都整包读解析 JSON, 单次操作耗时随条数线性增长 | `src/external/store.ts:37-49`, `r1-scale.ts` |
| D3 | DSH 外置宿主 | 远端引擎在启动时不可用, 外置宿主在整个进程生命周期内失效, 不重试 | `src/adapters/dsh/external-bridge.ts:41,84-85` |
| D4 | DSH 外置宿主 | 每个 pre-step 都跑一遍挫折反思并写一条纠正; 一轮 10 步就写 10 条重复纠正, 发 10 次反思调用 | `src/adapters/dsh/prestep.ts:175-193,248-250`, `r3-6.ts` R3 |
| D5 | 外部引擎 | LightRAG reset 忽略 corpusId, 多 corpus 重放后只剩最后一个; Hindsight 召回会被已失效条目占满 limit, 返回 0 条 | `src/external/lightrag.ts:13-15`, `src/external/hindsight.ts:80-93`, `r3-6.ts` R5/R6 |

另有非阻塞缺陷 D6–D17, 见各节。

## 2. canonical bundle (`src/external/canonical.ts`, `store.ts`, `migrate.ts`)

格式本身是对的: `parseBundle` 拒绝未知版本 (`canonical.ts:81-91`), id 白名单防路径穿越 (`canonical.ts:75-79`)。缺陷都在落盘层和迁移层。

### D1 多进程写同一 bank 写坏 bundle.json (阻塞)
- 触发条件: 两个或更多进程用同一个记忆根 (默认根是 `~/.dsh/hx-memory`, 见 `src/adapters/dsh/plugin-options.ts:29-34`。同一用户开两个 DSH 窗口打开同一仓库就满足), 并且同时向同一个 bank 写入。
- 实际现象: `writeAtomic` 用的是固定临时文件名 `path + ".tmp"`, 没有 fsync, 也没有锁 (`src/external/store.ts:123-128`)。两个进程截断、写入同一个 tmp 文件后各自 rename。复现脚本 `r2-race.ts` 让两个进程各 retain 200 条, 连续 4 次运行结果是: `writeErrors` 依次为 [173,198]、[115,61]、[167,193]、[71,178], 每次最后的 `bundle.json` 都抛 `SyntaxError: Unexpected non-whitespace character after JSON`。
- 后果: `readBank` 每次都要 `JSON.parse` 整个文件 (`store.ts:83-88`), 所以这个 bank 之后的每次 retain/recall/onSessionStart 都会抛错。DSH 侧所有调用都包在 `quietly` 里吞掉了异常 (`external-bridge.ts:203-209`), 用户看不到任何报错, 记忆层静默失效。canonical 是唯一真相 (`.agents/notes/implemented/architecture/2026-10-24-external-engine-ports.md` 第 Decision 段), 坏了就没有第二份数据可以恢复。对比: FileBackend 的原子写带 pid+时间戳的临时名和 fsync (`src/storage/markdown-codec.ts:149-167`), canonical store 没有复用它。

### D2 整包读写, 单次操作 O(N) (阻塞)
- 触发条件: bank 里的条目数增长。
- 实际现象: `saveMemory` 每写一条都要读整包、过滤、整包写回 (`store.ts:41-49`)。`getMemory` 每次都整包解析 (`store.ts:37-39`), 而 `host.recall` 对每个命中都调一次 `getMemory` (`src/external/host.ts:139-147`)。知识库同理: `searchKnowledge` 每个命中都调一次 `listDocs`, 每次都整包解析, 连 base64 图片一起 (`host.ts:272-276`)。实测 `r1-scale.ts`, 退出码 0:
  - N=500: 单次 retain 4.8 ms, 单次 recall 11.3 ms
  - N=2000: 单次 retain 20 ms, 单次 recall 47.8 ms, 写满 2000 条累计 20.2 s
  - N=4000: 单次 retain 40.8 ms, 单次 recall 82.8 ms, 写满 4000 条累计 74.4 s
- 后果: 写满一个 bank 的总耗时是 O(N²)。recall 在 pre-step 同步路径上 (`prestep.ts:248-250`), 条目越多, 每一步的首 token 延迟越长。现有 `tests/s1/external-perf.test.ts` 只测到 800 条, 不设上限曲线, 所以测不出来。

### D6 迁移窗口内丢写
- 触发条件: `reindexMemory` 执行期间, 另一个进程 (或同进程的另一个异步路径) 往同一个 bank 写入。
- 实际现象: `reindexMemory` 先 `exportBank`, 再 `await engine.upsert`, 最后 `importBank` 用导出时的快照整包覆盖 (`src/external/migrate.ts:11-21`)。`await` 期间写进来的记录会被覆盖掉。`reindexKnowledge` 同理 (`migrate.ts:31-37`)。
- 后果: 每个 DSH 进程启动都会对所有 bank 跑一遍 reindex (`external-bridge.ts:84-85`)。第二个窗口启动时, 会抹掉第一个窗口在此期间写入的记忆, 不报错。

### D7 迁移没有运维入口
- 触发条件: 运维想把引擎从 lexical 换成 Hindsight, 或在 Hindsight 和 Mem0 之间切换, 或导出导入 bundle。
- 实际现象: `swapMemory`、`swapKnowledge`、`importBank` 在 `src/external/` 之外没有任何调用方。命令 `grep -rn "swapMemory\|swapKnowledge\|importBank" src scripts --include=*.ts --exclude-dir=external` 退出码 1 (无匹配)。CLI `src/adapters/codex/cli.ts` 也没有导出导入子命令。
- 后果: 架构 note 把「canonical 是唯一迁移单位」列为核心承诺, 但现在只有库函数, 没有可执行的迁移步骤。实际的切换方式只有一种: 改环境变量后重启, 由 D3 里的启动重放顺带完成。

## 3. 外部引擎接入 (`src/external/hindsight.ts`, `mem0.ts`, `ragflow.ts`, `lightrag.ts`, `http.ts`)

共同前提: 四个适配器的测试都用模拟 `fetchImpl` (`tests/s1/external-engines.test.ts:22,56,108`), 仓库里没有一条对真实 Hindsight/Mem0/RAGFlow/LightRAG 服务的集成测试。命令 `grep -rn "HX_HINDSIGHT_BASE_URL\|HX_RAGFLOW_BASE_URL" tests scripts .github` 退出码 0, 唯一的匹配是 `tests/s1/external-dsh.test.ts:28-29`, 地址是 `http://127.0.0.1:9`, 用途是故意制造连接失败。

### D5a LightRAG reset 清掉所有 corpus (阻塞)
- 触发条件: 用 LightRAG 当知识库, 并且 canonical 里有两个或更多 corpus。每个 bank 对应一个 corpus (`external-bridge.ts:141`), 两个仓库就是两个 corpus。
- 实际现象: `reset()` 不看 corpusId, 直接 `DELETE /documents` (`src/external/lightrag.ts:13-15`)。`swapKnowledge` 和启动重放会逐个 corpus 先 reset 再 upsert (`migrate.ts:31-33`)。复现 `r3-6.ts` R5: canonical 里有 `corpusA`、`corpusB`, 重放后引擎里只剩 `docB`, 调用序列是 `DELETE, POST, DELETE, POST`。
- 后果: 除最后一个 corpus 外, 其余 corpus 的知识检索全部为空, canonical 里却标成 `indexed` (`migrate.ts:34-37`)。文档写着「一个进程一个 corpus」(`docs/external-engines.md` 边界段), 代码里没有任何强制。

### D5b Hindsight 召回被失效条目占满 (阻塞)
- 触发条件: 用 Hindsight 当记忆引擎, bank 里有被 supersede 或 invalidated 的记录 (每次纠正覆盖都会产生, 见 `host.ts:211-218`)。
- 实际现象: 失效只改 canonical, 不同步到引擎: 写入时 `hx_status` 固定为当时的值 (`hindsight.ts:62-70`), 之后再也不更新。`takeHits` 凑满 `query.limit` 就截断 (`hindsight.ts:80-93`), 宿主再过滤 status (`host.ts:142`)。复现 R6: 引擎返回 6 条, 前 5 条已失效, limit=5, 宿主返回 0 条。
- 后果: 纠正越多, 召回越空, 而且被优先挤掉的正是最新的有效纠正。原生 reflect 读的是引擎里的全部 facts (`hindsight.ts:41-54`), 已失效的旧纠正照样参与生成反思文本。`normalizeReflection` 只过滤 citations, 不过滤正文 (`src/external/reflect.ts:31-39`)。

### D8 Hindsight reset 只删第一页
- 触发条件: 一个 bank 在 Hindsight 里的条目超过 `/memories/list` 默认一页的条数。
- 实际现象: `reset()` 只请求一次 `GET /memories/list`, 不翻页 (`hindsight.ts:15-23`), 然后逐条 `DELETE`。
- 后果: 第一页之外的旧条目不会被删, 而每次启动又全量 upsert 一遍 (`external-bridge.ts:84`), 同一条 canonical 在引擎里会出现多份, 加重 D5b 的 limit 挤占。

### D9 RAGFlow: 错误判定、分页、重复版本、无超时
- 触发条件: 用 RAGFlow 当知识库。
- 实际现象:
  1. `requestJson` 只看 HTTP 状态码 (`src/external/http.ts:44-46`), 不读响应体里的 `code` 字段。RAGFlow 的 HTTP API 把业务错误放在 200 响应的 `code` 里, 所以业务失败会被当成成功, 文档被标成 `indexed` (`host.ts:258-262`)。
  2. `reset()` 固定 `page_size=200` (`ragflow.ts:13`), 第 201 份起的文档不会被删。
  3. `upsert()` 只上传, 不删同名旧文档 (`ragflow.ts:24-26`)。文档改动后, 同一个 docId 在引擎里新旧两版并存, `search` 可能把旧版片段映射到当前 canonical 路径上返回 (`ragflow.ts:40-49`, `host.ts:272-276`)。
  4. `uploadOne` 直接调 `fetch`, 没传 `signal` (`ragflow.ts:76-80`), 不受 `HX_ENGINE_TIMEOUT_MS` 控制。`JSON.parse(text)` 没有 try (`ragflow.ts:83`)。
- 后果: 知识库会出现假 indexed、残留旧版本和挂起的上传。

### D10 Mem0 改写和合并事实, id 往返不成立
- 触发条件: `HX_MEMORY_ENGINE=mem0`。
- 实际现象: `upsert` 以 `messages` 形式提交, 没有传 `infer: false` (`mem0.ts:15-27`; 命令 `grep -n "infer" src/external/mem0.ts` 退出码 1)。Mem0 OSS 的默认行为是对 messages 跑 LLM 抽取, 可能抽出 0 条、多条, 或把内容合并进已有记忆。按记录逐条串行 POST, 中途失败时整批留 pending, 下次全量重放时已成功的那部分会再写一遍。
- 后果: bakeoff 的硬门槛之一「canonical id 往返」(`src/external/bakeoff.ts:62-66`) 对 Mem0 不成立。`ENGINE_PROFILES` 把 Mem0 列为合格备选 (`bakeoff.ts:30-38`), 但没有对应的往返测试。每次启动重放还会对每条记录重复付一次 LLM 抽取费用。

### D11 所有远端调用不重试, pending 不补
- 触发条件: 引擎在运行中出现瞬时错误或超时 (默认超时 1500 ms, 见 `src/external/open.ts:25`)。
- 实际现象: `requestJson` 没有重试 (`http.ts:26-51`)。`retain` 失败后记录留在 `pending`, 注释写着「reindex 会把 pending 补上」(`host.ts:125-127`), 但唯一的 reindex 调用点是启动时的 `boot()` (`external-bridge.ts:84-85`), 进程运行期间没有任何补偿任务。
- 后果: 进程运行期间写入失败的记忆, 在重启前一直召回不到。

## 4. DSH 外置宿主 (`src/adapters/dsh/external-bridge.ts`, `prestep.ts`, `prestep-wiring.ts`)

### D3 启动时引擎不可用, 整个进程内外置宿主失效 (阻塞)
- 触发条件: DSH 启动时配置的 Hindsight/RAGFlow/LightRAG/Mem0 不可达, 或者 reset/upsert 报错。
- 实际现象: `ready = boot(deps)` 只在挂载时执行一次 (`external-bridge.ts:41`)。`boot` 里对所有 bank 和 corpus 串行 `reindexMemory`/`reindexKnowledge` (`external-bridge.ts:84-85`), 任何一次失败都会让 `ready` 进入 rejected。之后 `preface` 捕获异常返回空串 (`external-bridge.ts:63-65`), `workspace_memory` 和 `knowledge_search` 两个工具 `await ready` 直接抛错 (`external-bridge.ts:117,140`), 没有任何重建 `ready` 的路径。
- 后果: 一次启动时的网络抖动, 就会让开场卡片、按信号召回、轮末沉淀、挫折反思四条链路在整个进程生命周期里全部停掉, 只有一条 warn 日志也不会打 (日志只在 fallback 分支写, 见 `external-bridge.ts:86-93`)。另外, 每次启动都对全部 bank 做 reset 加全量 upsert, 启动耗时和远端调用量随总条数线性增长 (Hindsight 是逐条 DELETE, 见 `hindsight.ts:18-22`)。

### D4 每个 pre-step 重复做挫折反思并重复写入 (阻塞)
- 触发条件: 用户消息命中挫折判定 (`src/external/policy.ts:33-49`), 而且这一轮 agent 走了不止一个 step (只要调用一次工具就会有多个 step)。
- 实际现象: `agent/pre-step` 每一步都会触发 (`prestep.ts:175-193`, 没有按 step 或按轮去重), `latestUserText` 在同一轮里每一步都返回同一条用户消息 (`prestep.ts:41-60`), 每一步都调 `externalPreface` (`prestep.ts:248-250`), 进而调 `host.onUserMessage` (`external-bridge.ts:56-58`)。桥接层不传 `entities` (`external-bridge.ts:57`), 所以「同实体旧纠正失效」的条件 `entities.length > 0` 永远不成立 (`host.ts:211-217`)。复现 R3 (模拟 10 个 step): `reflectCalls=10`, `activeCorrections=10`。
- 后果: 一次骂人在一轮里写出 N 条内容重复、全部 active 的纠正, 发出 N 次反思调用 (Hindsight 原生 reflect 或 LLM 调用), 每一步还要多等一次远端往返。`onPreStep` 传入的已注入 id 永远是空数组 (`external-bridge.ts:60`), 同样的外置记忆每一步都会重新进入注入块。

### D12 读写 bank 口径不一致
- 触发条件: `runtime.scope()` 和 `runtime.project()` 都为空。`prestep-wiring.ts:75-82` 的注释记载过 0.2.0 宿主下真实发生过这种情况。
- 实际现象: 读取用 `projectKey() || input.project || input.sessionId` (`external-bridge.ts:49`), 写入用 `projectKey() || id` (session id, 见 `external-bridge.ts:200`), 工具用 `projectKey()`, 空串时落到 `"default"` (`external-bridge.ts:42,158-160`)。
- 后果: 同一会话写进 A bank, 读的是 B bank, 工具查的是 `default` bank, 三处互相看不见。

### D13 反思上下文只有用户这一句
- 触发条件: 任意一次挫折触发。
- 实际现象: `context: input.text` (`external-bridge.ts:57`), 传给反思的上下文就是骂人的那句话本身, 不含上一步 assistant 的动作和 diff。
- 后果: 反思的 disposition 要求「指出具体错在哪、涉及哪个文件或符号」(`policy.ts:8-9`), 但输入里没有这些信息, 结果只会是 insufficient 或凭空生成。`echoed-insult` 的检查只判断整句是否被原样包含 (`host.ts:226`), 部分复述能通过。而且在这条检查之前, 同实体的旧纠正已经被置为 invalidated (`host.ts:218`), 新条目又被判为复述作废, 旧的有效纠正因此一起丢失。

### D14 knowledge_search 在生产中永远为空
- 触发条件: DSH 中调用 `knowledge_search`。
- 实际现象: `syncDocs` 在 `src/external/` 之外没有调用方。命令 `grep -rn "syncDocs" src --include=*.ts --exclude-dir=external` 退出码 1。
- 后果: 工具已经注册 (`external-bridge.ts:126-148`), 但 corpus 永远没有文档, 每次都返回 `No document matched.`。

## 5. code-task-precipitate (`src/coding/precipitate.ts`)

### D15 没有接入任何运行路径
- 触发条件: 无, 现状就是如此。
- 实际现象: 命令 `grep -rn "precipitate\|runTurn" src --include=*.ts --exclude-dir=coding` 退出码 1, `src/index.ts` 也没有导出它。`runTurn` 是纯函数, 不持久化, 决定表由调用方传入传出 (`precipitate.ts:182-212`)。
- 后果: PR #4 合入的功能在 DSH 和 Codex 两个宿主里都不会执行。note 里「下一轮只要工作集碰到这个路径……就把当前决定整表注回」(`.agents/notes/implemented/feature/2026-10-31-code-task-precipitate.md` Decision 段) 在产品里不成立。

### D16 误触发与误覆盖
- 触发条件: 普通的修 bug 指令, 或含技术词的句子。
- 实际现象 (复现 R4):
  1. `"这个单测错了, 函数不能返回 null, 修一下"` 命中 `CORRECTION` 里的 `错了` (`precipitate.ts:34-35`), 写入 `src/x.ts` 的决定, 并且 `redo=true`。
  2. `"滚动条不对齐, 必须保持 8px 间距"` 命中 `INSULT` 里的 `滚` (`precipitate.ts:32-33`), 被判为骂人加纠正。`src/external/policy.ts:18` 已有的技术词压制表这里没有复用。
  3. 同一文件先后两条无关纠正 (「不要改导出的函数名」和「必须先写测试再改实现」) 都落到兜底 concern `correction` (`precipitate.ts:71-78`), 第一条被标成 superseded (`precipitate.ts:161-172`)。
  4. 文本里没有文件名时, scope 取工作集第一个文件 (`precipitate.ts:91-92`), 和纠正内容无关。
- 后果: 接入之后会把正常任务当成纠正并要求重做, 还会让同一文件上互不相关的约束互相覆盖。

## 6. 记忆写入与召回链路 (FileBackend 主链)

FileBackend 主链有明确的不变量和防护: 真相在文件, 索引可重建 (`src/storage/README.md` 不变量 1-7); 原子写带 fsync (`markdown-codec.ts:149-167`); SQLite 设了 busy_timeout, 并有跨进程测试 (`tests/s2/cross-process.test.ts:52,69`, 本次运行全量套件时已通过)。主链没有发现与 D1 同级的损坏缺陷, 但有以下两条已登记未修的问题:

### D17 跨进程丢更新 (已知未修)
- 触发条件: 两个进程同时对同一个真相 markdown 文件做读-改-写 (update 或 remove)。
- 实际现象: 源码注释明确写着「仍会丢一方的更新……需要跨进程锁才能根治 (不在本次范围)」(`src/storage/markdown-codec.ts:144-147`), README 的「并发」段写着「同一 id 并发写会出现两个块」(`src/storage/README.md` 并发段)。
- 后果: 多窗口共用一个根时, 撤回 (shadow) 或更新可能被另一个进程覆盖, 被撤回的条目会复活。

### 已登记未完成的整改项 (影响召回质量)
- `docs/memory-failure-audit-20261006.md:287` 的 P0-2「时效与状态语义位」标为未做。命令 `grep -rn "resolved_at\|resolvedAt" src` 退出码 1, 确认代码里没有。已完结的事项仍会被当作待办召回。
- 同一文件 `:519-527` 的 P1-6「记忆有用率评测纳入 verify」: `scripts/verify.sh` 中没有这一步 (全文 `step` 列表见 `scripts/verify.sh:25-80`)。审计记录的有用率是 1.4%–22.4% (`:118`), 抱怨后的记忆工具调用率是 3.5% (`:34-45`)。上线后没有指标能证明召回在起作用。

## 7. 测试覆盖

- 现有测试全绿 (第 0 节命令, 退出码 0), 但没有覆盖以下任何一条: D1 (`grep -rln "CanonicalStore" tests` 退出码 1, 没有任何测试直接测 canonical store 的并发或损坏)、D2 (perf 用例上限 800 条, 不检查增长曲线, 见 `tests/s1/external-perf.test.ts:28`)、D3 (没有「启动失败后恢复」的用例)、D4 (`tests/s1/external-dsh.test.ts:37-47` 只跑一个 step)、D5 (适配器全部用 mock, 见第 3 节)、D16 (`tests/coding/precipitate.test.ts` 只有正例和纯骂两类, 没有误触发样本)。
- 外部引擎没有契约测试, 没有对真实服务的冒烟, CI 里也没有起任何引擎容器 (`.github/workflows/ci.yml` 全文只有 install 和 `scripts/verify.sh`)。

## 8. 上线前必须关闭的项 (判据)

能/不能的判定只看这 5 条, 全部满足后才能改判为能:

1. D1: `r2-race.ts` 连续 20 次运行, `stored == 400` 且 `bundle.json` 可解析。
2. D2: `r1-scale.ts` 中 N=4000 时单次 recall ≤ 15 ms, 单次 retain ≤ 10 ms (阈值以 N=500 时的现值为基准)。
3. D3: 启动时引擎不可达、之后恢复, 同一进程内 `workspace_memory` 能返回结果, 并有对应测试。
4. D4: 同一轮多个 step 只触发一次反思, 只写一条纠正 (`r3-6.ts` R3 结果为 `reflectCalls=1`, `activeCorrections=1`)。
5. D5: R5 重放后引擎里同时有 `docA`、`docB` (或启动时拒绝多 corpus 加 LightRAG 的组合); R6 结果为 `hostReturned=1`。并且至少 Hindsight 和 RAGFlow 各有一条对真实服务的 CI 冒烟。

## 附录 A 复现脚本

在仓库根目录下建 `.tmp/` 并放入以下文件, 用 `node --experimental-strip-types --no-warnings .tmp/<文件名>` 运行。三份脚本只读写系统临时目录, 不碰仓库数据。

### A.1 `.tmp/r1-scale.ts`

```ts
import { mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
import { createExternalHost } from "../src/external/host.ts";
import { lexicalKnowledgeEngine, lexicalMemoryEngine } from "../src/external/lexical.ts";
for (const n of [500, 2000, 4000]) {
  const host = createExternalHost({ root: mkdtempSync(join(tmpdir(), "s")), memory: lexicalMemoryEngine(), knowledge: lexicalKnowledgeEngine() });
  let t = performance.now();
  for (let i = 0; i < n; i++) await host.retain({ bankId: "ws_a", kind: "decision", text: "条目 " + i + " cache-ttl-" + (i % 40) });
  const total = performance.now() - t;
  t = performance.now(); for (let i = 0; i < 20; i++) await host.retain({ bankId: "ws_a", kind: "decision", text: "tail " + i });
  const tail = (performance.now() - t) / 20;
  t = performance.now(); for (let i = 0; i < 20; i++) await host.recall({ bankId: "ws_a", query: "cache-ttl-3", limit: 8 });
  const rec = (performance.now() - t) / 20;
  console.log(JSON.stringify({ n, retainLastOpMs: +tail.toFixed(1), recallOpMs: +rec.toFixed(1), totalRetainS: +(total/1000).toFixed(1) }));
}
```

### A.2 `.tmp/r2-race.ts`

```ts
// 两个进程同时向同一 bank retain 200 条, 数最终条数
import { fork } from "node:child_process"; import { mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
import { CanonicalStore } from "../src/external/store.ts";
if (process.argv[2] === "child") {
  const { createExternalHost } = await import("../src/external/host.ts");
  const { lexicalKnowledgeEngine, lexicalMemoryEngine } = await import("../src/external/lexical.ts");
  const host = createExternalHost({ root: process.argv[3]!, memory: lexicalMemoryEngine(), knowledge: lexicalKnowledgeEngine() });
  let err = 0;
  for (let i = 0; i < 200; i++) { try { await host.retain({ bankId: "ws_a", kind: "decision", text: process.argv[4] + i }); } catch { err++; } }
  process.send!({ err }); process.exit(0);
} else {
  const root = mkdtempSync(join(tmpdir(), "race"));
  const run = (tag: string) => new Promise<number>((res) => { const c = fork(new URL(import.meta.url).pathname, ["child", root, tag], { execArgv: ["--experimental-strip-types", "--no-warnings"] }); c.on("message", (m: any) => res(m.err)); });
  const errs = await Promise.all([run("A"), run("B")]);
  let count = -1; try { count = new CanonicalStore(root).listMemories("ws_a").length; } catch (e) { console.log("read error", String(e).slice(0, 120)); }
  console.log(JSON.stringify({ expected: 400, stored: count, writeErrors: errs }));
}
```

### A.3 `.tmp/r3-6.ts`

```ts
import { mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
import { createExternalHost } from "../src/external/host.ts";
import { lexicalKnowledgeEngine, lexicalMemoryEngine } from "../src/external/lexical.ts";
import { lightRagKnowledgeEngine } from "../src/external/lightrag.ts";
import { hindsightMemoryEngine } from "../src/external/hindsight.ts";
import { runTurn } from "../src/coding/precipitate.ts";
const tmp = () => mkdtempSync(join(tmpdir(), "r"));
// R3: 同一条辱骂消息在一个 turn 的 10 个 pre-step 上各调用一次 onUserMessage (external-bridge.ts:56-58 的调用形状)
{
  const host = createExternalHost({ root: tmp(), memory: lexicalMemoryEngine(), knowledge: lexicalKnowledgeEngine(),
    complete: async () => JSON.stringify({ insufficient: false, text: "改 src/a.ts 前先读调用方", citations: [] }) });
  let calls = 0; const orig = host.reflect.bind(host); host.reflect = async (i) => { calls++; return orig(i); };
  for (let s = 0; s < 10; s++) await host.onUserMessage({ bankId: "ws_a", text: "你这个傻逼又改错 src/a.ts", context: "你这个傻逼又改错 src/a.ts" });
  const active = host.store.listMemories("ws_a").filter((r) => r.kind === "correction" && r.status === "active").length;
  console.log("R3", JSON.stringify({ steps: 10, reflectCalls: calls, activeCorrections: active }));
}
// R4: precipitate 误触发与误覆盖
{
  const a = runTurn([], { text: "这个单测错了, 函数不能返回 null, 修一下", diff: "", workingSet: ["src/x.ts"] }, "d1");
  const b = runTurn([], { text: "滚动条不对齐, 必须保持 8px 间距", diff: "", workingSet: ["src/ui.tsx"] }, "d1");
  let d = runTurn([], { text: "不对, 不要改导出的函数名", diff: "", workingSet: ["src/x.ts"] }, "d1").decisions;
  d = runTurn(d, { text: "错了, 必须先写测试再改实现", diff: "", workingSet: ["src/x.ts"] }, "d2").decisions;
  console.log("R4", JSON.stringify({ normalFix: { reasons: a.signal.reasons, written: a.written?.scope, redo: a.redo },
    scrollbar: { reasons: b.signal.reasons, written: b.written?.scope, redo: b.redo },
    twoUnrelated: d.map((x) => ({ id: x.id, concern: x.concern, status: x.status })) }));
}
// R5: LightRAG reset 不看 corpusId, 两个 corpus 重放后只剩最后一个
{
  const docs = new Map<string, string>(); const log: string[] = [];
  const fetchImpl = async (url: any, init: any) => { const u = String(url); log.push(init.method + " " + u.replace("http://l", ""));
    if (init.method === "DELETE") docs.clear(); else if (u.endsWith("/documents/text")) { const b = JSON.parse(init.body); docs.set(b.file_source, b.text); }
    return new Response("{}", { status: 200 }); };
  const host = createExternalHost({ root: tmp(), memory: lexicalMemoryEngine(), knowledge: lexicalKnowledgeEngine() });
  await host.syncDocs("corpusA", [{ id: "docA", path: "a.md", markdown: "alpha", assets: [], updatedAt: "2026-11-01T00:00:00Z" }]);
  await host.syncDocs("corpusB", [{ id: "docB", path: "b.md", markdown: "beta", assets: [], updatedAt: "2026-11-01T00:00:00Z" }]);
  await host.swapKnowledge(lightRagKnowledgeEngine({ baseUrl: "http://l", fetchImpl: fetchImpl as any }));
  console.log("R5", JSON.stringify({ canonicalCorpora: host.store.listCorpora(), engineDocsAfterSwap: [...docs.keys()], calls: log }));
}
// R6: Hindsight 返回的前 limit 条命中是已失效记录时, 召回为空
{
  const host = createExternalHost({ root: tmp(), memory: lexicalMemoryEngine(), knowledge: lexicalKnowledgeEngine() });
  const ids: string[] = [];
  for (let i = 0; i < 6; i++) { const r = await host.retain({ bankId: "ws_a", kind: "decision", text: "端口 " + i }); ids.push(r.id); }
  for (const id of ids.slice(0, 5)) host.store.saveMemory({ ...host.store.getMemory("ws_a", id)!, status: "invalidated" });
  const fetchImpl = async () => new Response(JSON.stringify({ results: ids.map((id) => ({ document_id: id, metadata: { hx_id: id } })) }), { status: 200 });
  host.memory = hindsightMemoryEngine({ baseUrl: "http://h", fetchImpl: fetchImpl as any });
  const got = await host.recall({ bankId: "ws_a", query: "端口", limit: 5 });
  console.log("R6", JSON.stringify({ engineReturned: 6, liveInCanonical: 1, limit: 5, hostReturned: got.length }));
}
```

### A.4 本次实测输出 (原样)

```
r1-scale.ts (退出码 0)
{"n":500,"retainLastOpMs":4.8,"recallOpMs":11.3,"totalRetainS":1.7}
{"n":2000,"retainLastOpMs":20,"recallOpMs":47.8,"totalRetainS":20.2}
{"n":4000,"retainLastOpMs":40.8,"recallOpMs":82.8,"totalRetainS":74.4}

r2-race.ts (连续 4 次)
read error SyntaxError: Unexpected non-whitespace character after JSON at position 7786 (line 314 column 2)
{"expected":400,"stored":-1,"writeErrors":[173,198]}
read error SyntaxError: Unexpected non-whitespace character after JSON at position 41486 (line 1656 column 4)
{"expected":400,"stored":-1,"writeErrors":[115,61]}
read error SyntaxError: Unexpected non-whitespace character after JSON at position 9445 (line 380 column 2)
{"expected":400,"stored":-1,"writeErrors":[167,193]}
read error SyntaxError: Unexpected non-whitespace character after JSON at position 34843 (line 1392 column 4)
{"expected":400,"stored":-1,"writeErrors":[71,178]}

r3-6.ts (退出码 0)
R3 {"steps":10,"reflectCalls":10,"activeCorrections":10}
R4 {"normalFix":{"reasons":["纠正"],"written":"src/x.ts","redo":true},"scrollbar":{"reasons":["骂人","纠正"],"written":"src/ui.tsx","redo":true},"twoUnrelated":[{"id":"d1","concern":"correction","status":"superseded"},{"id":"d2","concern":"correction","status":"active"}]}
R5 {"canonicalCorpora":["corpusA","corpusB"],"engineDocsAfterSwap":["docB"],"calls":["DELETE /documents","POST /documents/text","DELETE /documents","POST /documents/text"]}
R6 {"engineReturned":6,"liveInCanonical":1,"limit":5,"hostReturned":0}
```
