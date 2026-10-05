# 溯源链修复: 从常量来源到可解引用血缘

> 目的: 记录"每条记忆可溯源"这条产品承诺在数据层的落地情况 —— 原先它在数据上不成立, 本轮修好并端到端验证。
> 边界 (不写什么): 不讨论 Wiki/条目式范式取舍 (见 wiki-blind-review.md); 不复述实现细节。
> 与代码的关系: 修复映射到 `src/adapters/dsh/runtime.ts` / `tools.ts` / `index.ts`; 契约测试在 `tests/s2/source-and-lineage.test.ts`。

## 1. 问题: 来源是一个常量

`memory_save` 工具 (agent 主动写记忆的唯一入口) 硬编码 `source: "session:tool"` [src/adapters/dsh/tools.ts]。实测本项目真库:

| 来源取值 | 条数 | 占比 |
| --- | --- | --- |
| 常量 `session:tool` | 98 / 125 | **78%** |
| 含真实 session id | 26 / 125 | 21% |
| 其它 (`user:dsh-web`) | 1 | 1% |

**后果**: "这条记忆来自哪次会话"不可回答。产品层承诺的"可溯源"因此没有承载物 —— 不是界面没做, 是数据里没有。

> 更正记录: 我在此前的 `docs/eval-audit.md` §3 写过"116/125 条是常量、含 episode 引用的 0 条"。该数字**有误** —— 它来自只打印前 10 行的统计, 且 `derived_from` 的 0 是在错误的文件集上数出来的 (真库实际有 29 行 `derived_from`)。准确值见上表与 §3。

## 2. 修复

```text
HxMemoryRuntime.onSessionStart(session)  →  记录 lastSessionId
                    ↓
registerMemoryTools(ctx, { sourceOf: () => runtime.sessionId() })
                    ↓
memory_save:  source = "session:" + sessionId   (取不到时退回旧常量, 不静默丢语义)
```

工具本身拿不到 Session (宿主只传 agent), 而 runtime 在会话开始时就知道 id —— 因此由装配层注入访问器, 而不是让工具猜。

## 3. 端到端验证 (真实路径, 非单测桩)

`.tmp/bench/verify-source-e2e2.ts` 走**真实捕获路径** (`flushTurn` ← `capture-ledger`):

| 验证项 | 结果 |
| --- | --- |
| `memory_save` 带真实会话来源 | source = `session:session-REAL-9999` |
| 取不到会话时退回旧常量 | source = `session:tool` (向后兼容) |
| 捕获路径写出 `derivedFrom` | 1 条, `["ep9d27c867c7c6444a","ep4521df3f02904e5f"]` |
| **血缘解引用回原话** | 2 个 id → **命中 2 条原文** (`记住: 血缘引用必须能被解引用...` / `已记录: ...`) |
| episode 落盘 | 1 个文件, 2 条轮次 |

"可溯源"现在是**可执行的** —— 从一条记忆能真的走到产生它的那轮对话原文。

契约测试 `tests/s2/source-and-lineage.test.ts` 5 项全绿, 钉住三条不变量: 真实来源、回退兼容、**不同会话的来源必须不同** (否则按会话回溯形同虚设)。

## 4. 遗留

1. **历史数据未迁移**: 那 98 条 `session:tool` 的来源无法补回 —— 写入时就没记, 原文虽在 episode 日志里但没有任何指针能把它们连起来。这是不可逆的信息损失, 只能随时间被新数据稀释。
2. **`sessionId()` 是"最近一次"而非"当前"**: 多会话并发时 (面板 RPC 与主会话同时写) 可能取到另一个会话的 id。当前是单用户单机场景, 影响有限; 若将来支持并发会话, 需改成按 agent/session 上下文传递。
3. `user:dsh-web` 这类其它来源形态未统一口径 (仅 1 条, 不影响结论)。
