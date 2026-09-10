# HX-Memory

> **自维护 · 可插拔 · 跨项目推广的 Agent 记忆层** — 让 AI 记住你的踩坑, 把"项目 A 的教训"自动变成"所有项目的规则"。

![CI](https://img.shields.io/github/actions/workflow/status/HengXin666/HX-Memory/ci.yml?label=ci)
![boot-smoke](https://img.shields.io/github/actions/workflow/status/HengXin666/HX-Memory/boot-smoke.yml?label=boot-smoke)
![license](https://img.shields.io/github/license/HengXin666/HX-Memory)
![ts](https://img.shields.io/badge/TypeScript-5.7-3178c6)

---

## 它解决什么问题

大多数 Agent 记忆系统只有**单个项目内的"记与取"**: 今天在这个仓库踩的坑, 明天换一个仓库, 同样的坑再踩一遍。

HX-Memory 补上缺的那一环 —— **跨项目推广**:

```text
在项目 A 踩坑 "我所有容器实际上都有并发策略问题"
        ↓  自动捕获 → 聚类 → 生成推广提议
        ↓  你打开面板点一下"确认"
        ↓
一条全局规则: "凡是涉及容器/并发的任务, 先检查并发策略"
        ↓  自动注入到 任何项目 的新会话
项目 B、C、D… 的 AI 从此都知道这个教训
```

**没有你的确认, 机器不会推广任何规则** —— 推广是人工闸门, 不是 AI 自作主张。

---

## 快速上手 (30 秒看懂怎么用)

### 第一步: 装上

```bash
npm i -g @deepseek-ai/dsh
dsh plugin add @hengxin666/hx-memory   # 发布后; 本地开发: dsh plugin add file:<本仓库路径>
```

**本地开发时更新插件 (`file:` 依赖有个坑)**: 改完代码先 `pnpm run build && pnpm run build:client`,
再重装。但 pnpm 对"内容变了的 `file:` 依赖"**会显示 `Already up to date` 而不重新拷贝** ——
若两次构建之间**新增或删除过文件**, 结果是新旧混杂 (被改动的文件因硬链接变成新版, 新增文件根本没进来),
插件启动即崩。可靠做法是先删掉再装:

```bash
pnpm run build && pnpm run build:client
rm -rf ~/.dsh/profiles/web/node_modules/@hengxin666/hx-memory
cd ~/.dsh/profiles/web && pnpm install
```

验证装对了 (本地 `dist` 与安装副本必须逐文件一致):

```bash
diff -rq dist ~/.dsh/profiles/web/node_modules/@hengxin666/hx-memory/dist && echo OK
```

> 注意 `scripts/smoke-dsh.sh` 用的是**隔离的临时 DSH_HOME**, 因此跑它不会碰你的真实记忆。
> 若要手动对真实 host 跑 `scripts/smoke-dsh-http.mjs`, 它会**覆盖 `<root>/bindings.json`** —— 先备份。

**版本**: 插件声明 `peerDependencies: @deepseek-ai/dsh-* ^0.1.2-rc.1`, 但两条宿主路径都实测可用:

- 设置面板: 0.1.2-rc.1 走 `ctx.settings.installSection` (接住权威配置 thunk); 0.1.1 走
  `ctx.settings.register(ns, schema, { base })` + `scope.get()`。两条路径都真的注册 `hx-memory`
  命名空间 (真机门禁断言 `settings.describe`)。
- 会话事件: 0.1.2-rc.1 移除了 `Session.events`, 插件统一经 `session-events.ts` 做能力探测
  (`eventAt(surface.nodes)` → `snapshotEvents()` → `events`), 并按 surface 过滤。

Node ≥ 22.5 (存储层用 `node:sqlite`)。

### 第二步: 找一个入口

装好后, 你会在 **DSH 设置区看到两个新面板**:

| 面板         | 在哪                | 用来干什么                                 |
| ------------ | ------------------- | ------------------------------------------ |
| **记忆审阅** | DSH 设置 → 记忆审阅 | 攒了一批推广提议时, 逐条**确认/驳回**      |
| **记忆绑定** | DSH 设置 → 记忆绑定 | 为每个项目声明"要绑哪些记忆源"(VCP 式拓扑) |

### 第三步: 正常聊天, 剩下的交给它

记忆捕获是**自动的**: 你在对话里踩坑、做决策、表偏好, 都被隐式记下; 也可以直接说 "记住 X"。

---

## 使用入口 (你可以在哪些地方触达它)

| #   | 入口                    | 在哪里                                 | 怎么触发                                                             | 你会得到什么                                                    |
| --- | ----------------------- | -------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------- |
| ①   | **自动捕获**            | 任何 DSH 会话                          | 正常对话 (踩坑/决策/偏好被隐式记录); 或说 "记住 X"                   | 记忆落盘 → 之后的会话自动想起                                   |
| ②   | **绑定管理面板**        | DSH 设置 → 记忆绑定                    | 打开面板, 为项目声明记忆源拓扑 (查询/权重/信号词)                    | 可视化增删改, 保存即生效                                        |
| ③   | **审阅面板**            | DSH 设置 → 记忆审阅                    | 收到推广提议时, 逐条确认/驳回                                        | 确认的提议变成全局规则                                          |
| ④   | **确定性注入** (自动)   | 每个 `agent/pre-step`                  | 绑定命中的项目, 每次对话自动注入绑定记忆                             | 模型每步都带着相关记忆 (测试 10/10 命中)                        |
| ⑤   | **记忆工具** (模型可调) | DSH 工具区                             | 模型自主调用 `memory_search` / `memory_save` / `memory_rule_propose` | 按需检索 / 保存 / 提议规则                                      |
| ⑥   | **推广批次**            | DSH 设置 → 记忆审阅                    | 点「运行推广批次」                                                   | 聚类最近的经验成待审提议, 并给出漏斗报告 (候选/跳过/簇/产出/AI 是否启用) |
| ⑦   | **Codex CLI**           | 终端                                   | `hx-memory sync/rules/stats/verify/rebuild`                          | 同步 AGENTS.md / 列规则 / 统计 / 一致性自检 / 分级重建          |
| ⑧   | **MCP 服务**            | Claude Code / Desktop / Cursor / Cline | `hx-memory mcp --root <memRoot>` 配成 MCP server                     | 六个工具 (search/save/link/history/forget/stats) 共用同一份记忆 |
| ⑨   | **衰减整合**            | 终端 / 定时任务                        | `hx-memory consolidate [--dry-run]`                                  | 短命记忆按衰减/TTL 置为 `expired` (可逆, 永不删除)              |

> 简单说: **① 自动记, ④ 自动注入, ② 管绑定, ③+⑥ 管推广, ⑤ 手动兜底, ⑦⑧ 换宿主用, ⑨ 管遗忘**。
>
> 所有入口 (DSH 工具/面板、MCP、CLI) 都经由同一个 `MemoryFacade` —— **换宿主不换语义**:
> 同一条检索排序、同一套治理闸门 (未确认规则永不召回)、同一份可见性口径 (shadow/expired 默认隐藏)。

### 换成别的宿主 (MCP)

任何支持 MCP 的客户端 (Claude Code / Desktop、Cursor、Cline…) 都能接上同一份记忆:

```jsonc
// 客户端配置示例 (stdio)
{
  "mcpServers": {
    "hx-memory": { "command": "hx-memory", "args": ["mcp", "--root", "/path/to/memory-root"] },
  },
}
```

工具: `memory_search` / `memory_save` / `memory_link` / `memory_history` / `memory_forget` / `memory_stats`。
它们与 DSH 工具**共用同一个 Facade 与同一条检索语义** —— 换宿主不换记忆, 也不换规则 (共识与治理闸门一致)。

> 推广闭环有两个触发点: 面板按钮 (聚类最近的经验) 与 `memory_rule_propose` 工具 (模型直接提议)。
> 两条都只进人工队列, 都不会自动变成规则。

---

## 端到端示例 (真实场景)

**场景**: 你同时在维护多个微服务仓库, 容器并发策略的坑反复踩。

```text
1. 在仓库 A 的会话里排查一个问题, 你总结: "我所有的容器实际上都是有并发策略问题的"
   → HX-Memory 自动捕获这条经验 (隐式信号: 踩坑/决策)

2. 过一会儿, DSH 设置 → 记忆审阅 里出现一条推广提议:
   "所有容器都有并发策略问题 → 建议全局规则: 涉及容器/并发时先检查并发策略"
   → 你点【确认】

3. 打开 DSH 设置 → 记忆绑定, 给项目 B 绑定这条规则源 (或直接用全局默认)
   → 保存即生效

4. 在项目 B 开新会话, 讨论"给容器加并发限制"
   → agent/pre-step 确定性注入: 模型一上来就带着"容器→并发策略"这条经验
   → 不用你说, 它先检查并发策略 —— 而不是等你踩完坑再教它
```

**双线对照** (`tests/s2/dual-line.test.ts`): 同一条规则、同一份记忆库, 旧线 (靠模型自觉调 memory_search) 用"模型 60% 概率记得调工具"模拟出 6/10; 新线 (声明式绑定 + 确定性注入) 由代码判定, **10/10**。

> [!NOTE] 这是一条**单元级**对照 (证明"注入与否由代码决定"这一机制), 不是真实模型的命中率测量;
> 真实链路的证据是 `scripts/smoke-dsh.sh` 的真机行为门禁 (见下)。

---

## 亮点 (产品能力, 不是工程底线)

### 🧠 1. 跨项目推广: 一条经验, 所有项目受益

- 记忆的终点不是"记住", 而是"在别处也生效"。
- 机器只提议, **人工闸门确认**后才成为全局规则; 确认记录 (谁/何时/实例) 永久留存。
- 规则 → 实例双向链接, 推广可追溯。

### 🎯 2. 读记忆不靠模型自觉 (VCP 式声明式绑定)

- 传统做法: 告诉模型"你可以调 memory_search" —— 模型是概率机, 该搜时不搜 (幻觉自足), 不该搜时乱搜。
- 本版: 项目声明**记忆绑定拓扑** (查询/权重/条数/信号词门控), 代码在 `agent/pre-step` **确定性注入**, 每步用最新用户文本检索。
- 绑定配置存 `root/bindings.json` (真相在文件), 设置面板可视化编辑, 保存即生效。 <!-- verify-docs:allow (运行时数据文件) -->

### 📁 3. 真相在文件, 索引可重建, 记忆可演化

- 记忆本体是 **Markdown 文件** (人可读/可审计/可 git diff); SQLite 只存派生索引, 删库不丢真相。
- 索引重建是**无损**的: relations / tags / structured 都写进文件并可被 `rebuildFromFiles()` 读回 (有测试钉住)。
- 双时态 `validAt` / `assertedAt`; 演化链语义在 `kernel/evolution.ts` 且关联可重建。
- `project` 是第一等字段, 记忆因此分三层: **全局规则** (跨项目) / **项目经验** (按仓库隔离) /
  **`scope:"agent"` 共享层** (跨工作区, 不属于任何项目, 对每个项目都常驻注入)。
  项目键 = **会话工作目录所属仓库的目录名** (git root; 非 git 目录回退目录名) ——
  同一 monorepo 的任意子包得到同一个键, 经验不会按子包碎片化; 跨仓库仍然隔离。
- 检索按**目的**分层: 注入 (`purpose:"inject"`, 默认) 带规则保底; 显式搜索/面板浏览
  (`purpose:"recall"`) 只按相关性排 —— 面板搜索的前几条不再是无条件垫在最前的规则。

### ♻️ 6. 记忆会自己更新 (三档演化, 规则永不被机器改)

写入时按"证据强度"分三档 (ADR-024):

- **合并 (自动)**: 换个说法重记 → 不重复落盘, 强化老条目并把新标签/实体并进去;
- **取代 (自动, 需显式信号)**: 说"上限**改为** 50"或"这条**不再**适用"时 —— 新条目 `supersedes` 旧的, 旧的置 `superseded` + `supersededBy`, **不删除**, `history` 可查完整版本链, 检索只注入最新版;
- **冲突标记 (不裁决)**: 数字/极性矛盾但没有更新信号 → 双向 `contradicts` 边, **两条都保留** —— 谁对谁错交给人, 机器不猜。

**规则 (rule) 豁免**: 机器只能标记"某条规则可能过时", 永不自动改写/删除规则 (人工闸门)。
另外, 共享标签/实体的记忆会自动建 `relates` 边 (默认最多 3 条, 有上限防关联爆炸), 这条边进真相文件、重建后仍在。

### 🧠 7. 语义检索 (换个说法也找得到)

默认就带**离线语义**: 同义词表归一 (上线/发版→发布, 兜底→熔断) + 字级 n-gram, 零依赖零联网。

| 配置                                                         | 效果                                             | 说明                                                                                                       |
| ------------------------------------------------------------ | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| 默认 (`LexicalEmbedder`)                                     | 同义改写 **Recall@1 20%→80%, Recall@3 20%→100%** | 离线、同步、零依赖                                                                                         |
| `HX_MEMORY_EMBEDDING_BASE_URL` + `HX_MEMORY_EMBEDDING_MODEL` | 真语义模型                                       | OpenAI 兼容协议 (OpenAI/Ollama/vLLM/TEI/自建); 异步嵌入 + 后台投影, 预步注入带**硬时限**预热, 永不阻塞对话 |
| `embedder: null` (API)                                       | 关闭语义通道                                     | 只保留字面检索                                                                                             |

阈值由**嵌入器自己声明** (不同模型分数尺度不同, 全局阈值必然一边失效); 语义不可用时结果里会带 `degraded` 说明, 不静默。

```bash
node --experimental-strip-types scripts/eval-retrieval.ts   # 语义召回质量评测 (Recall@1/@3)
node --experimental-strip-types scripts/bench-retrieval.ts 10000 [--semantic]   # 万级性能
```

### 🔁 8. 分级重建 + 引擎准入 (为什么"换引擎"是接线而不是改造)

- **T1 索引重建**: 真相文件 → 结构化/全文索引 (`rebuildFromTruth`, 幂等)。
- **T2 抽取重建**: `episodes/YYYY-MM-DD.jsonl` 原文 → 记忆条目 (`rebuild --episodes`)。换了抽取器/规则后**重放**而不是重聊: 同一抽取器重放结果与当初一致 (幂等), 换了抽取器则新结果落盘、旧结果置 `superseded` (不删除, 历史可查)。
- **引擎准入**: `tests/conformance/` 一套契约跑所有实现 (往返无损 / 治理铁律 / 可见性 / 重建幂等 / 自检 / 持久化); 新增引擎只需加一个 `describeBackend`。当前已覆盖 FileBackend 与 MemoryBackend 两个实现。
- **索引身份**: 派生索引带 `schemaVersion` (格式 + 分词版本), 不符即重建, 不许混用。

```bash
hx-memory stats   --root <memRoot>   # 统计 + 引擎状态
hx-memory verify  --root <memRoot>   # 索引 ↔ 真相 一致性自检 (不一致返回 1)
hx-memory rebuild --root <memRoot>              # T1: 索引 ← 真相
hx-memory rebuild --root <memRoot> --episodes   # T2: 记忆 ← 原文重放
hx-memory consolidate --root <memRoot> [--dry-run]  # 衰减扫描 (过期可逆, rule/lesson 永不过期)
```

**用进废退**: 被检索并注入的记忆会 `reinforcement+1` 并刷新 `lastHitAt` (同一分钟内的重复命中合并成一次),
因此常用记忆衰减更慢; 反之从未被用到的 `event`/`context` 会先过期。
`lesson`/`decision`/`rule` 永不自动过期 (只降权), 且"过期"只是状态 —— 真相文件里仍在, `revive` 可拉回。

> [!NOTE] 未实现: `supersedes` 链目前由**重建 (T2)** 与人工 `memory_link` 写入;
> 会话中的自动冲突消解 (新记忆推翻旧记忆) 仍在计划中 (见 docs/architecture-v2.md §4.3),
> 且规则类改动永远走人工闸门。

### 🔌 4. 自维护内核 + 可插拔接入

- **Port-Adapter 架构**: 内核零依赖, harness 与存储全是 adapter; 1 套 API, DSH / Codex 共用。
- 设计思想借鉴 VCP / ReMe / Hy-Memory, 代码 100% 自维护, 无外部依赖漂移。

### 🔒 5. 推广全流程人工可审

- 后台批量聚类 → 提议进队列 → 面板逐条确认/驳回 → 只有确认的落盘为全局规则。
- 不会出现"AI 擅自把一条经验推广到所有项目"的事故。

---

> **工程保证** (底线, 不是亮点): 专门的 **boot-smoke CI** 在全新 runner 上装 DSH → 装本插件 → 真机启动 web host, 断言插件组组合成功、进程存活、无插件加载崩溃。任何"装完 DSH 起不来"的回归都会被当场拦下。

---

## 架构一览

> 目标架构 (四层切面: Surface / Application / Ports / Engines) 见 [docs/architecture-v2.md](docs/architecture-v2.md);
> 市面方案对标见 [docs/open-source-landscape.md](docs/open-source-landscape.md)。

```text
src/
  kernel/          # 核心内核 (Port): 只定义抽象, 零依赖
    types.ts       # MemoryEntry / Relation / Query / Scope (project 第一等字段) + Episode/演化字段
    ports.ts       # MemoryStore / HarnessAdapter / Generalizer + Retriever/能力自述 (v2)
    cjk.ts         # 中英混排分词: 词流 + CJK bigram (索引/查询对称)
    ranking.ts     # RRF 融合 / 时间衰减 / 强化 / MMR / token 预算 (纯函数)
  app/             # 使用层唯一 API
    facade.ts      # MemoryFacade: remember/recall/revise/forget/link/history/stats
    rebuild.ts     # 分级重建: T1 索引 ← 真相 / T2 抽取 ← episode 原文 (换抽取器用)
  retrieval/       # 检索层 (端口实现)
    hybrid.ts      # 多通道召回 → RRF → 覆盖率过滤 → 衰减 → MMR → 预算
  evolution/       # 演化层
    associate.ts   # 写入期裁决: 归一化指纹 / 近义去重 / 自动建边
  capture/         # 捕获引擎: turn → MemoryEntry (kind 推断/指纹去重/双时态) + pipeline
  recall/          # 召回引擎: 全局规则跨项目生效 + 项目内经验按需召回
  generalize/      # 推广引擎: 聚类 → 提议 → review 队列 (人工闸门 confirm→rule)
  kernel/binder.ts # VCP 式声明式绑定: 项目 → 记忆源拓扑, 确定性注入
  bindings/        # 绑定配置持久化 (root/bindings.json, truth-in-files)
  adapters/        # 接入层: 1 套 API 的多个实现
    dsh/           #   DSH (cordis 插件: 会话捕获/工具/Web 面板 + Typert gateway)
                   #   prestep.ts        pre-step 确定性注入 (跨 step 去重)
                   #   llm-agent.ts      agents 服务调用 (真实 create/followup/whenIdle 契约)
                   #   settings-source.ts 持有宿主设置源 thunk (设置改动能生效)
                   #   client/rpc.ts     Web 面板 ↔ gateway 的唯一 RPC 入口 (/api + {args})
    codex/         #   Codex (AGENTS.md 同步 + CLI)
  storage/         # 存储层: FileBackend (默认, 真相在文件+SQLite 索引) / 可插拔
    fts-index.ts   # FTS5 全文索引 (双列 词/bigram, 带分词版本号, 不可用时降级 LIKE)
    file-store.ts  # 真相文件 ↔ 索引 (往返无损, 含演化字段) + Rebuildable (身份自述/重建/自检)
    episode-store.ts # Episode 追加日志 (原文真相, 支撑抽取级重放; 可开关 + 保留期)
    memory-store.ts  # 纯内存第二实现 (证明端口可插拔; 同一套 conformance 测试)
  index.ts
scripts/
  lib/wrap-client-bundle.mjs  # client bundle 包装 (模块 id = 包名, 可单测)
  smoke-dsh.sh                # 真机 DSH 行为门禁
```

## 能力闭环

```text
会话捕获 → lesson 落盘 (truth-in-files) → 批量推广 → 人工确认 → 全局规则
                                                                   ↓
                任何项目的新会话 start → 召回规则注入 context (跨项目生效)
```

---

## 测试与门禁

| 层               | 位置                   | 内容                                                                                                           |
| ---------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------- |
| S1 内核          | `tests/s1`             | 纯逻辑, 禁网络 (binder / 端口一致性 / 双时态)                                                                  |
| S2 接入+存储     | `tests/s2`             | 临时资源/stub: 存储完整性、pre-step 去重、设置生效、agents 契约、推广触发、client RPC 约定                     |
| S3 完整 DSH      | `tests/s3`             | 事件接线 (假 harness)                                                                                          |
| **引擎准入**     | `tests/conformance`    | 同一套契约跑所有存储/检索引擎 (往返无损/治理/可见性/重建幂等/自检/持久化); 不过不许进 `src/storage`            |
| static           | `tsc --noEmit` ×2      | 内核 + client 双类型闸门                                                                                       |
| **真机行为门禁** | `scripts/smoke-dsh.sh` | 隔离 `DSH_HOME` 装插件 → 启 web host → 断言 fiber active / 6 个 RPC 业务成功 / 绑定写读真往返 / bundle 模块 id |

```bash
pnpm install
pnpm run verify           # build + static + 全部单测 (统一入口)
bash scripts/smoke-dsh.sh # 真机 DSH 行为门禁 (需要 dsh + 网络)
```

**为什么要有真机门禁**: 插件可以"装得上、进程不崩、fiber active", 而面板仍然整块 404 ——
组合层 (`isolate`)、模块 id、RPC 约定这三类问题只有真机跑一遍才看得见。所以
`scripts/smoke-dsh.sh` 逐条断言 profile 组合、两个 fiber 状态、6 个 RPC 端点、
以及客户端 bundle 注册的模块 id 与 boot manifest 行 id 一致。

**数据完整性门禁** (`tests/s2/file-store-*.test.ts` + `cross-process`): 正文与 frontmatter 都不能
伪造块/字段 (写入转义 + 值域校验, 否则一条普通记忆能在重建后凭空造出"已确认规则")、索引丢失
自动从真相重建、**两个进程真并发**同时打开同一索引不报 `database is locked`、撤回是持久的、
relations/tags/structured 重建无损、CRLF/BOM/反斜杠矩阵逐字往返、更新不重排块顺序、
块外手写前言在写入后保留 (真相文件真的可手编)。

> 手写/外部工具编辑真相文件时: `valid_at` / `asserted_at` 必须是 `Z` 结尾的 ISO 串
> (`2026-07-01T00:00:00.000Z`), 否则该条目会被跳过并记 warning; 条目之间用空行分隔
> (单换行也能读, 但"正文以换行结尾 + 单换行分隔"会丢一个换行)。

**CI**: `.github/workflows/ci.yml` (build + 类型 + 单测) + `.github/workflows/boot-smoke.yml` (真机行为门禁)。

---

## 设计决策

> 8 条 ADR 记录了每一步取舍: [docs/adr.md](docs/adr.md) · 架构分层: [docs/architecture.md](docs/architecture.md)

| ADR | 决策                                                                        |
| --- | --------------------------------------------------------------------------- |
| 015 | 四层切面 (Surface/Application/Ports/Engines), 依赖方向单向                  |
| 016 | 检索独立成端口 (Retriever), 同步判定点用投影解决                            |
| 017 | 全文索引默认 FTS5 + "词 + CJK bigram" 双流分词                              |
| 018 | Episode 原始轮次是真相的一部分 (支撑抽取级重建)                             |
| 019 | 演化字段进真相文件; 遗忘是状态而不是删除                                    |
| 020 | 引擎准入 = conformance 套件                                                 |
| 021 | 多宿主 = 一个 Facade + 多个 Surface; MCP 优先                               |
| 001 | 自维护内核 + adapter, 不整包引入市面项目                                    |
| 002 | 真相在文件 (Markdown), 索引在库 (SQLite), 可重建                            |
| 003 | 推广 = 后台提议 + 人工 review 队列                                          |
| 004 | 双时态 `validAt` + `assertedAt`                                             |
| 005 | `supersedes` 演化链 (版本化记忆)                                            |
| 006 | 全 TypeScript, 前端嵌入 DSH 宿主 Web                                        |
| 007 | `project` 第一等字段 (跨项目隔离与生效)                                     |
| 008 | "何时读记忆"由声明式绑定决定, 不靠模型自觉 (VCP 式)                         |
| 009 | 宿主契约必须真机验证: 组合层/模块 id/RPC 约定用 `scripts/smoke-dsh.sh` 钉住 |
| 010 | `project` 键 = 会话工作目录所属仓库名 (而非 session id 或目录名), 捕获/绑定/召回全链路统一 |
| 011 | 真相 → 索引必须无损往返 (relations/tags/structured 全部写回文件并可读回)    |

## License

Apache-2.0
