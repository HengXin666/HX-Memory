# 记忆系统四时机对照: HX-Memory vs dsh-memory vs longmemory vs 上游

目的: 回答「**什么时候取记忆、什么时候存记忆、什么时候查记忆、什么时候注入生效**」这四个问题,
把本仓与市面实现放在**同一张表**上比, 并标出每一处差距的**可证伪判据**。

边界 (不写什么): 不评产品优劣; 不推测闭源二进制与远端服务的内部算法 (只记录**实测到的输出形态**);
不含安装步骤。所有结论都能指到具体文件与行号  没有一处是推测。

与代码的关系: HX-Memory 侧每条判据指向本仓 `src/`; 被比较的插件是**实际下载/本机安装的产物**而非文档描述。

## 零、被比较的对象 (取证方式)

| 对象 | 版本 | 取证方式 | 规模 |
| --- | --- | --- | --- |
| **HX-Memory** (本仓) | 0.1.0 | 源码 + 真库 + 7 天会话流水 | `src/**/*.ts` 155 文件 / 26213 行 |
| **dsh-memory** (npm 官方命名) | 0.1.0 | `npm pack dsh-memory@0.1.0` 解包全文通读 | 单文件 lib/index.js, 420 行 |
| **@jacklika/dsh-memory** (bundle) | 0.1.7-rc.11 | `npm pack` 三个成员包解包通读 | bundle 声明 8 行 + curator 239 行 + filesystem 646 行 |
| **dsh-longmemory-plugin** (本机已装) | 0.2.0 | 本机 `~/.dsh/plugins/` 全文通读 + 既有对比文档 | 单文件 431 行 |
| 上游 (mem0 / Graphiti / Letta / MIRIX / LlamaIndex…) | — | 独立调研报告 `/tmp/up/upstream-memory-playbook.md` (92 URL) | — |

> ⚠ **两个不同的包都叫 `dsh-memory`**: npm 上 `dsh-memory@0.1.0` (作者 bbnopromo) 是**单文件 SQLite 实现**;
> `@jacklika/dsh-memory` 是**Obsidian vault + 写阶梯**的 bundle。两者形态完全不同, 下面分别列。

---

## 一、四时机总表 (一屏看完)

| 时机 | **HX-Memory** | **dsh-memory@0.1.0** | **@jacklika/dsh-memory** | **longmemory 插件** |
| --- | --- | --- | --- | --- |
| **① 取记忆** (何时召回) | `agent/pre-step` **每步**判定; 由 `TriggerPolicy.decide` 决定注入/跳过 | **无钩子**; 由 `systemPrompt.section('memory:recall')` **每次装配 system prompt 时**求值 | **无钩子**; 纯工具, 模型主动调 `memory_recall` | `agent/pre-step` **每轮一次** (用 `sessionId:turn` 去重), 闭源二进制 `recall` |
| **② 存记忆** (何时写入) | `session/event` → 聚合 turn → **每轮判定** (多档闸门 + LLM 提炼 + 待审) | **无自动写入**; 只有模型主动调 `memory_write` | **无自动写入**; 模型主动调 `memory_capture` (含冲突检测) | `agent/turn-stopping` **每轮一次**; 把**助手最后一段文本**发给远端 `write` |
| **③ 查记忆** (显式检索) | `memory_search` 工具 (BM25+向量+图+实体 + RRF + 弃权闸门) | `memory_search` 工具 (纯 FTS5 MATCH) | `memory_recall` → 转发 `wiki_search` (字段加权 OR) | **无检索工具** (远端 recall 自动注入, 模型不主动查) |
| **④ 注入生效点** | `agent/pre-step` 的 **waterfall 返回值** → 追加一条 `role:user` 消息 | **system prompt 的一个 section** (`order:50`) | 无被动注入 (纯工具) | 同上: waterfall 返回值 → 追加 `role:user` 消息 |

### 一句话概括四种形态

- **dsh-memory@0.1.0**: 「**把记忆放进 system prompt**」。零钩子、零判定  装了什么就每轮都在眼前。
- **@jacklika/dsh-memory**: 「**把记忆做成一个 vault, 让模型自己管**」。零被动注入, 全靠工具纪律。
- **longmemory**: 「**每轮问一次远端, 每轮把回答存一次远端**」。钩子点最少, 但两端各一次网络往返。
- **HX-Memory**: 「**本地判定 + 多渠道注入 + 自动沉淀**」。钩子最多、闸门最多、代码量最大 (26k 行 vs 200~650 行)。

---

## 二、逐时机的实现细节

### ① 取记忆

**dsh-memory@0.1.0  挂在 system prompt 上, 而不是钩子**

```js
// lib/index.js:246-250
ctx.systemPrompt.section({
  name: "memory:recall",
  order: config.promptOrder,   // 默认 50
  text: () => renderPrompt(open().forPrompt(config.promptRecentCount), config.promptMaxChars),
});
```

- `text` 是**每次装配求值**的函数 (dsh-system-prompt 的 `PromptSection.text` 契约) ⇒ **每轮自动生效**, 无需任何钩子。
- 取法是 `forPrompt()`: **pinned 全要, 再补 `promptRecentCount`(默认 10) 条最近更新的** (`index.js:124-128`)。
- 预算是**字符数** `promptMaxChars`(默认 2000), 超出的**丢弃并数条数** (`index.js:185-203`), pinned 先发所以能活过紧预算。

**@jacklika/dsh-memory  完全不注入**

三个成员包全部只有 `ctx.tools.register` (`curator/index.js:92,115` / `filesystem/index.js:481,504,571`),
**零 `ctx.on`、零 `systemPrompt.section`**。取记忆 = 模型调 `memory_recall`。

**longmemory  钩子 + 远端, 每轮一次**

```js
// ~/.dsh/plugins/dsh-longmemory-plugin/index.js:131-136
ctx.on('agent/pre-step', async ({ agent, messages, signal, turn }, next) => {
  if (messages.length === 0) return next()
  const recallId = `${agent.session.header.id}:${turn}`;
  if (recalledTurns.has(recallId)) return next();   // 一轮内多次 pre-step 只查一次
```
- 用 **`sessionId:turn` 做键**去重  注释写明理由: "otherwise the same remote context is repeatedly injected and charged"。
- 超时 **5s** (`recallTimeoutMs`), 失败只 `warn` 不抛 (`warnOnFailure`)。

**HX-Memory**


```ts
// src/adapters/dsh/prestep.ts:186-240 (判定) → src/trigger/policy.ts:118-119 (预算)
decision = policy.decide({ text, hasAlwaysOn, previousQuery, lastInjectedAt });
// mode ∈ always-on | intent | drift-refresh | skip-similar | skip-no-signal
```
- 两个预算常量: `alwaysOnBudget = 400` / `intentBudget = 300` (`policy.ts:118-119`)。
- 与 longmemory 的**关键差异**: longmemory 是"每轮无条件查远端"; HX-Memory 是"**先判定该不该查**"
  (`skip-similar` 同话题刚注入过就跳过、`skip-no-signal` 无信号就不查)  省调用, 但代价是
  判定错一次就漏一次 (实测 226 次抱怨之后只触发 8 次记忆调用, 见审计文档第二节)。

### ② 存记忆

| 系统 | 触发 | 写入内容 | 谁决定写什么 |
| --- | --- | --- | --- |
| dsh-memory@0.1.0 | 模型显式调 `memory_write` | 模型给的**一段自足事实** | 模型 (工具描述里明令禁止存 transient task state / secrets) |
| @jacklika/dsh-memory | 模型显式调 `memory_capture` | title + summary + tags 的 **Markdown note** | 模型; 有**冲突检测** (标题/id 搜索命中则问准) |
| longmemory | `agent/turn-stopping` 自动 | **助手最后一段文本全文** | 远端二进制 |
| HX-Memory | `session/event` 自动 | 用户原话 / 规则推断 / LLM 提炼出的 conclusion | 本地管线 (`capture/pipeline.ts`) |

**longmemory 的写法值得单独看**  它是唯一"拿助手输出当素材"的:

```js
// index.js:163-186
ctx.on('agent/turn-stopping', async ({ agent, turn, signal }) => {
  const assistantText = [...agent.session.deriveMessages()].reverse()
    .find(m => m.role === 'assistant')?.content
    .filter(b => b.type === 'text').map(b => b.text).join('');
  if (!assistantText) { /* 释放 claim */ return; }
  const { output } = await invoke(agent, 'write', {
    ...basePayload(agent, 'Stop'), last_assistant_message: assistantText,
  }, writeTimeoutMs, signal);   // 60s
```
- **去重靠 receipt 文件 + claim**: `.dsh/logs/dsh-longmemory-write-receipts/<sha256>.json`,
  带 `pending` 状态与 `staleAfterMs=120s`  跨进程防重入。
- 还要**等远端回执** (`waitForWriteDone`, 10s / 每 100ms 轮询), 拿到才算成功。

**HX-Memory 的写入是多档闸门**, 而这三家都只有一档:

```
capture/pipeline.ts  疑问句+无结论 → 丢; 陈述句 → 落盘 + 记待审; 负面信号轮 → 走 lessonDraft 不落原话
capture/signals.ts   inferKind 优先级: 显式指令 > 负面信号 > 规则/禁令 > lesson > decision > preference > context(兜底)
```

### ③ 查记忆

| 系统 | 工具 | 检索算法 | 空结果行为 |
| --- | --- | --- | --- |
| dsh-memory@0.1.0 | `memory_search` | **纯 FTS5 MATCH**; 每个 token 加引号 (防模型输入的 `OR`/`*` 改语义); 隐式 AND | `No memories match "…".` |
| @jacklika | `memory_recall` → `wiki_search` | 字段加权 OR; 稀有词权重高; 反链 boost; 可选接语义 | 返回空数组 |
| longmemory | **无** | — | — |
| HX-Memory | `memory_search` | 6 通道 (rules/bm25/vector/tag/graph/entity) → RRF → MMR → 弃权闸门 | 两档 (见下) |

**dsh-memory@0.1.0 有一处值得本仓学的细节**  它把 FTS5 操作符**当字面量**处理:

```js
// index.js:48-58
function compileMatch(query) {
  const tokens = query.split(/[^\p{L}\p{N}_]+/u).filter(t => t.length > 0).map(t => `"${t}"`);
  return tokens.length > 0 ? tokens.join(" ") : void 0;
}
```
模型随手打的 `OR` / `*` / `-` 不会改变查询语义, 也不会在工具调用中途抛 FTS 语法错。**本仓没有这道防护** (见差距表 D-3)。

### ④ 注入生效点

| 系统 | 生效机制 | 注入内容的位置 | 能否被 token 预算裁剪 |
| --- | --- | --- | --- |
| dsh-memory@0.1.0 | `systemPrompt.section` | **system prompt** (order 50, 在 persona 之后) | 自管字符预算 (2000) |
| @jacklika | — (无) | — | — |
| longmemory | `agent/pre-step` 返回值发成 **user 消息** | 消息流 (在宿主 context 之后) | 由远端决定长度 |
| HX-Memory | `agent/pre-step` 返回值发成 **user 消息** | 消息流 (带 `source.entryIds`) | 400 token 常驻 + 300 意图 |

**两种生效点有本质差别** (这决定了省不省 token):

- **system prompt section**: 每轮请求都带上 ⇒ **与 KV cache 前缀绑定**。dsh-memory 把 `promptOrder` 暴露成配置项,
  文档里专门有一段 "KV Cache effect"; 而对 longmemory 的 bundle, README 明说 `The bundle itself adds no request prefix`。
- **user 消息**: 进对话历史, 一旦注入就**永久占上下文**, 且会参与后续轮次的注意力 
  本仓因此必须自己实现差量注入 (`injection-dedupe.ts` + `source.entryIds`), 否则同一条记忆每轮重发。

---

## 三、差距表 (按"值不值得抄"排序)

| # | 差距 | 本仓现状 | 对方做法 | 判据 (怎么算改好了) |
| --- | --- | --- | --- | --- |
| **D-1** | **常驻内容没有"人可置顶"的通道** | 全靠 `score` 自动选 (rule 100 分恒定, 实际选出 7 规则 + 2 agent 偏好, **项目条目 0 条**) | dsh-memory 的 `pinned` 布尔位: "Always show this memory in context. Reserve it for facts that matter in every session." | 加一个 `pinned`, 且 `selectAlwaysOn` 优先发 pinned; 真库上项目条目必须至少能进 1 条 |
| **D-2** | **`memory_search` 的范围按进程快照取 ⇒ 多会话同进程串扰** | 已修 (本轮): 改为 `exec.agent.session` 优先 | dsh-memory **根本没有 scope 概念** (单库单用户), 因此没有这个坑 | `tests/s2/scope-per-call.test.ts` 2 条断言; 且本轮实测已复现过"在 HX-Memory 目录搜出 freebuff-proxy 结果" |
| **D-3** | **检索查询没做操作符转义** | 查询词直接进 FTS5/LIKE | dsh-memory `compileMatch` 逐 token 加引号 | 加一条用例: 查询 `a OR b` / `a*` / `-a` 必须当字面量, 不改变结果集 |
| **D-4** | **自动写入 vs 显式写入的取舍未论证** | 每轮自动判定 (钩子最多、闸门最多) | dsh-memory / jacklika / mem0 v3 都**只让模型显式写**; longmemory 只写助手末段 | 用**注入里 context 占比**当判据: 现在 50.6%, 目标是 <10% (见审计文档 P1-4) |
| **D-5** | **没有"冲突检测"这一问** | 捕获不去比对既有条目 | jacklika 的 `memory_capture` 先 `wiki_search(title)` + `wiki_search(targetId)`, 命中即**问人** | 新增 `memory_save` 的冲突回执 (命中则返回"已存在同义条目 #id, 是否合并") |
| **D-6** | **常驻预算按 token 而非字符, 且没有"还剩多少没显示"的回执** | 400 token 截断后**静默** | dsh-memory 超出时给 `(N more memories not shown; use memory_search)` | 注入块尾部加同行回执, 让模型知道"还有没给的" |

### 双方各自比对方强的地方 (不做单边吹)

**HX-Memory 强于三者的地方 (有实测支撑)**:

1. **检索深度**: 6 通道 + RRF + MMR + 弃权闸门 + 覆盖率门槛  三家分别是 1 通道 (FTS5) / 1 通道 (字段加权) / 0 (无工具)。
2. **写入闸门**: 负面信号→lessonDraft、疑问句无结论→丢、待审队列  三家都没有多档判定。
3. **差量注入**: `source.entryIds` 让同一条记忆一个会话只发一次  三家都没有 (dsh-memory 每轮重发全部常驻, 靠 system prompt 的 KV cache 兜)。
4. **可溯源**: 每条记忆带 `source` + episode 原文  longmemory 的溯源在**闭源远端**。

**三者强于 HX-Memory 的地方**:

1. **可预测性**: dsh-memory 的规则简单到可以口述 (pinned + 最近 N 条)  用户永远知道下一轮会看到什么;
   本仓的注入内容是 5 个 mode × 6 通道 × 3 个预算的合成, 连作者都要跑 `schedule/*.jsonl` 才说得清。
2. **写入纪律**: 只让模型显式写, 从源头避免了"用户原话被当记忆"(本仓 50.6% 的注入是 context 回显)。
3. **代码体量**: 420 行 vs 26213 行。**可审计性是功能的一部分**  这份文档能逐行读完 dsh-memory, 但读不完本仓。

---

## 四、可抄清单 (按投入产出排序)

1. **`pinned` 位 (D-1)**  半天的活, 直接解决"项目条目一条都进不了常驻通道"。
2. **FTS 查询转义 (D-3)**  20 行的活, 消掉一整类"模型打错一个字符就报错/改语义"。
3. **超预算回执 (D-6)**  一行字符串, 让模型知道"还有没给的"。
4. **写入冲突检测 (D-5)**  借鉴 jacklika 的 `wiki_search(title)` 前置检查; 这是**入库期**做的事, 比检索期去重便宜。
5. **把常驻内容改成"有上限的文档块"** (D-4 的根因, 上游 Letta 的做法)  大改, 需先做对照实验。

---

## 五、取证命令 (可复现)

```bash
# 1) 下载两个 dsh-memory 候选 (npm 上同名的是两个不同的包)
mkdir -p /tmp/dshmem/a && cd /tmp/dshmem/a && npm pack dsh-memory@0.1.0 && tar xzf *.tgz
mkdir -p /tmp/dshmem/b && cd /tmp/dshmem/b && npm pack @jacklika/dsh-memory@0.1.7-rc.11 && tar xzf *.tgz

# 2) 本机已装的那个闭源桥接插件
wc -l ~/.dsh/plugins/dsh-longmemory-plugin/index.js    # 431 行
grep -n "ctx.on(" ~/.dsh/plugins/dsh-longmemory-plugin/index.js

# 3) 四时机只读比对 (钩子清单)
grep -rn "ctx.on(\|systemPrompt.section\|tools.register" /tmp/dshmem/*/package/lib/index.js
grep -rn "ctx.on(\|systemPrompt.section\|tools.register" /home/hx/Loli/code/HXLoLis/components/HX-Memory/src/adapters/dsh/
```
