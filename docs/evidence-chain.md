# 证据链: 让"可溯源"从承诺变成可执行

> 目的: 记录"一条记忆 → 产生它的原始对话原话"这条查询路径的落地 —— 此前 `derivedFrom` 存了 id 却无处可查。
> 边界 (不写什么): 不讨论存储范式取舍 (见 wiki-blind-review.md); 不复述来源字段本身的修复 (见 source-lineage-fix.md)。
> 与代码的关系: 端口在 `src/kernel/ports.ts`, 实现在 `src/storage/episode-store.ts`, 门面在 `src/app/facade.ts` 的 `evidenceChain()`, 工具在 `src/adapters/dsh/tools.ts`, 契约测试在 `tests/s2/evidence-chain.test.ts`。

## 1. 断在哪

`MemoryEntry.derivedFrom` 一直存着 episode id (真库 29 行), episode 日志也一直在 (527 条轮次)。但**中间的查询路径不存在**:

| 层 | 修复前 | 修复后 |
| --- | --- | --- |
| 端口 | 只有 `all/since/bySession` | 增加 `byIds()` |
| 存储 | 无按 id 查询 | `byIds()` 按 at 升序返回 |
| 门面 | 无 episode 面 | `evidenceChain(id)` |
| 工具 | 无 | `memory_evidence` |

于是"这句话是怎么来的"在产品层回答不了 —— 数据都在, 缺的是那一跳。

## 2. 设计取舍

**只提供批量原语 `byIds`**: 一条记忆天然对应多轮 (user + assistant), 单 id 版本由调用方传单元素数组, 避免同一段逻辑写两遍。

**不建 id 索引**: 日志按天分文件, 而 `derivedFrom` 至多几条 —— 建索引的收益不抵维护风险 (索引必须与真相一致, 而 episode 是追加写、永不改写、还会被保留期按整天删除, 任何索引都要处理跨天追加与 prune)。

**证据源是可选的最小契约** (`EvidenceSource`, 只依赖 `byIds` 一个方法): facade 不因此硬依赖存储实现 (换引擎/换宿主不该改业务代码 —— 与既有端口化原则一致)。

**工具独立于 memory_search**: 检索给的是**结论**, 证据链要的是**原话**。两者代价不同 (前者近乎免费, 后者要读日志), 分层下钻的前提是分开计价。

## 3. 三条实现纪律

1. **原文优先**: 返回未经改写的 episode 原文, 绝不用 content / 摘要冒充 (与 recall 的硬规则同源)。
2. **如实降级**: 取不到就说清缺在哪, 而不是返回看起来成功的空结果 —— 静默的空是最坏的失败形态。三种 reason 各自可区分:
   - 该条目没有记录血缘 (历史数据常态, 实测真库 78% 的来源是常量)
   - 未接入 episode 原文源 (装配时缺 evidence)
   - 原文已不可取 (可能已过保留期) —— 附带缺失的 id 列表
3. **顺序还原对话**: 按 `at` 升序返回, 调用方据此还原"用户问 → 助手答"的次序。

## 4. 端到端证据 (真实捕获路径, 非单测桩)

`.tmp/bench/verify-evidence-chain.ts` 走 `flushTurn` ← `capture-ledger`:

```text
条目: c2168f6a6c295d6cd  derivedFrom=["epc68e10892328418e","epb403d3d38d5642ed"]
traceable = true
source    = session:session-ev-1
episodes  = 2 轮
   [user turn=3] 记住: 证据链必须能追到未改写的原始对话原话
   [assistant turn=3] 已记录: 证据链必须能追到未改写的原始对话原话。

工具面 (memory_evidence c2168f6a6c295d6cd):
[entry c2168f6a6c295d6cd] 证据链必须能追到未改写的原始对话原话
source: session:session-ev-1
traceable: yes
--- raw turns (untouched) ---
[user turn=3 ...] 记住: 证据链必须能追到未改写的原始对话原话
[assistant turn=3 ...] 已记录: 证据链必须能追到未改写的原始对话原话。
```

降级路径同样实测:

| 场景 | 结果 |
| --- | --- |
| 无血缘条目 | `traceable=false`, reason = "该条目没有记录血缘 (写入时未捕获 episode 引用)" |
| 原文被清理 | `traceable=false`, reason 含 "不可取", `episodes` 为空 (不顶替) |
| 不存在的 id | 返回 `null` (不抛错) |

契约测试 6 项, 覆盖上述全部分支。DSH 工具面现为 5 个: `memory_search / memory_save / memory_evidence / memory_flag / memory_rule_propose`。

## 5. 遗留

1. **历史数据仍不可溯**: 那 98 条来源为常量的条目, 写入时没记血缘, 无法补 —— 只能靠新数据稀释 (见 source-lineage-fix.md §4)。
2. **`byIds` 是 O(全量扫描)**: 当前 episode 规模 (527 条) 下无感; 若增长到十万级需重新评估 (届时可加按天分片的 id 索引, 但要先解决与 prune 的一致性)。
3. **面板未接**: 能力已在门面与工具层可用, 但 DSH 面板还没有"点开看原话"的入口。工具面已够 agent 用, 人侧入口待补。
4. **MCP 面未暴露** `memory_evidence` (DSH 面已暴露) —— 两个宿主面的工具清单本就不等 (DSH 5 个 / MCP 7 个), 是否补齐属产品取舍。

## 8. 面板入口 (2026-09-18 完成)

此前"可溯源"只有 **agent 侧**入口 (`memory_evidence` 工具), 人侧没有任何入口 —— 用户看到一条结论却查不到出处, 就无从判断该不该改它, "用户握有最终编辑权"也就落不了地。

### 8.1 三层接线 (每一跳都有契约约束)

| 层 | 改动 | 约束 |
| --- | --- | --- |
| 白名单 | `remote-methods.ts` 增 `"evidenceChain"` | 宿主按 namespace/method 路由, 写错 = **静默 404** (无编译错误、无运行时异常) |
| 服务端 | `gateway.ts` 增 `@Remote("evidenceChain")` | 与工具走**同一个 Facade 方法**, 两侧口径必然一致 |
| 客户端 | `review-page.tsx` 新沉淀行加「追来源」按钮 + 展开区 | 按需取 (每条要读 episode 日志, 全量预取会拖垮面板 —— 与审阅展开同一取舍) |

窄化依赖: `gateway` 的 facade 面从 `Pick<"recent"|"forget"|"recall">` 扩为含 `evidenceChain`, 不让 gateway 与整个 Facade 耦合。

### 8.2 面板看到的降级原因 (与工具一致)

| 场景 | 面板表现 |
| --- | --- |
| 可完整溯源 | 显示 `来源: session:xxx · 可完整溯源` + **未经改写的原始对话** |
| 无血缘 | `溯源不完整` + 原因 (该条目没有记录血缘) |
| 原文已清理 | `溯源不完整` + 缺失的 id 列表 (不拿其它内容顶替) |
| 宿主未重启 (不认识该端点) | 一次性提示"宿主可能需重启才能提供该端点", 不逐条报错 |

最后一条是既有经验: 宿主进程比面板活得久, 只重建 dist 不重启宿主就会遇到旧契约 —— 直接报错会打爆整个面板。

### 8.3 验证

| 项 | 结果 |
| --- | --- |
| `tests/s2/gateway-evidence.test.ts` (新, 7 项) | 全通过 |
| 其中"面板与工具同一份数据" | 工具输出的每条原文都出现在面板返回里 |
| 白名单含 `evidenceChain` | 断言通过 (防静默 404) |
| 前端构建 | `dist/dsh/client.js` 产出成功, 产物内确认含 `evidenceChain` / `evidenceOpen` 等 |
| 全量 | **921 passed / 0 failed** (118 文件) |
| 门禁 | `verify-structure` 115 文件通过; lint **0 error** |

顺带把 gateway 从 406 行顶回 **393** 行 (超限是我加端点造成的, 不能自己制造超限): 抽出 `gateway-memory.ts` 承载"记忆读取出口"投影 (与既有 `gateway-review.ts` 同模式)。

### 8.4 遗留

1. **未做浏览器真机验证**: 断言覆盖到 RPC 层与构建产物, 但"点击按钮后界面长什么样"未在真实页面上点过。宿主需重启才能加载新端点。
2. **CLI 侧无对应命令**: `hx-memory` CLI 未暴露证据链 (工具面与面板已有)。
