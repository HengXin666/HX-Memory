# DSH 触发点清单 (记忆注入在哪里挂)

> 目的: 把 DSH 宿主**所有可以挂记忆注入的位置**列成一份可核对的清单 (类似 VCP 的插件态 hook),
> 说明每个点的时机、契约、能看见什么、不能做什么, 以及本项目当前是否使用。
> 边界 (不写什么): 不写记忆系统内部设计 (见 [architecture-v2.md](architecture-v2.md)); 不写宿主安装教程 (见 [README](../README.md))。
> 与代码的关系: "本项目状态"一列对应 `src/adapters/dsh/` 的实现; 契约细节来自宿主源码与文档 (下方"证据"一节)。

## 0. 一句话

VCP 的做法是把日记占位符写在 Agent 模板里, 由 `processMessages` 在请求前**无条件**解析注入;
DSH 的等价物是 **cordis 的 waterfall / event 插件点** —— 其中 `agent/pre-step` 是"每轮必过、可以改注入内容"的那个点,
`system-prompt/assemble` 是"系统提示词级"的点, `tools/pre-execute` 是"模型调工具前"的点。
三者的可靠性递减: **pre-step (强制) > system-prompt (强制但无轮次语义) > 工具 (概率)**。

## 1. 触发点总表

| 触发点                                     | 类型      | 时机              | 能否改写注入内容                          | 本项目状态                            |
| ------------------------------------------ | --------- | ----------------- | ----------------------------------------- | ------------------------------------- |
| `agent/pre-step`                           | waterfall | 每轮每一步开始前  | **能** (在 `next()` 结果上追加 user 消息) | **已用** —— 触发层 + 绑定注入的主通道 |
| `agent/session-start`                      | event     | 会话建立时        | 能 (`agent.inject`)                       | **已用** —— 记忆使用指引              |
| `system-prompt/assemble`                   | waterfall | 组装系统提示词时  | **能** (改 `assembly.variables` / 文本)   | 未用 —— 候选 (见 §3)                  |
| `agent/request`                            | waterfall | 每次模型请求前    | 能                                        | 未用 —— 与 pre-step 重叠, 优先级低    |
| `tools/pre-execute`                        | event     | 工具执行前        | 不能 (只能观察/拦截)                      | 未用                                  |
| `tools/post-execute`                       | event     | 工具执行后        | 不能                                      | 未用 —— 可用于"工具失败 → 建议查记忆" |
| `session/event`                            | event     | 会话产生任何事件  | 不能 (只读)                               | **已用** —— 捕获 turn 与派发 episode  |
| `agent/session-start` / `session/disposed` | event     | 会话生命周期      | 能 (前者)                                 | **已用** —— 缓冲冲刷                  |
| `agent/error` / `agent/request-error`      | waterfall | 出错时            | 能 (可返回 retry)                         | 未用                                  |
| `llm/stream`                               | waterfall | 流式请求          | 能                                        | 未用 —— 侵入性强, 不建议记忆层用      |
| `subagent/start` / `subagent/end`          | event     | 子 agent 生命周期 | 不能                                      | 未用 —— 目前靠 `rootAgentsOnly` 过滤  |

> 上表的"类型"含义: **event** = 广播通知 (能读能注入副作用, 但改不了别的消费者的结果);
> **waterfall** = 中间件 (拿到 `next()`, 可以改写入参/返回值) —— 记忆注入必须用 waterfall 才能**保证**内容进入本轮。

## 2. 三个关键点位的契约

### 2.1 `agent/pre-step` (主通道, 每轮必过)

```ts
ctx.on("agent/pre-step", async ({ agent, messages, step, signal }, next) => {
  const decision = await next();              // 先拿宿主/其它插件的决定
  if (decision.kind !== "enter") return decision;
  // 在这里把记忆作为"上下文 user 消息"追加进 decision.messages
  return { kind: "enter", messages: [...decision.messages.slice(0, idx + 1), injected, ...] };
});
```

- **为什么是主通道**: 它在每一步的模型请求之前、拿得到"最新一轮用户文本", 且能改变实际发送的消息。
- **约束**: 同步判定点上要做异步检索必须自带投影/缓存 (本项目用 `Binder.warm()` 带硬时限预热)。
- **去重**: 注入出去的消息会进入会话日志, 下一个 step 的 claimed batch 里看不到它 —— 必须扫**模型可见的**历史事件 (`surface.nodes`) 去重, 否则每步重复注入 (本项目 `prestep.ts` 已处理)。
- **来源标记**: 注入消息用 `source.kind = "plugin"` 并带 plugin 名, 便于 (a) 去重, (b) 避免把自家注入当成用户输入再捕获。

### 2.2 `system-prompt/assemble` (系统提示词级)

```ts
ctx.on(
  "system-prompt/assemble",
  async (assembly, context, next) => {
    const assembled = await next();
    if (context.agent === undefined) return assembled;
    return { ...assembled, variables: { ...assembled.variables /* … */ } };
  },
  { prepend: true },
);
```

- **适用**: 全局、不随轮次变化的内容 (相当于 Letta 的 `system/` 常驻块)。
- **不适用**: "与当前话题相关"的记忆 —— 这里拿不到本轮用户文本, 而且系统提示词通常被缓存/复用,
  把易变内容塞进去会破坏前缀缓存并放大成本。
- **本项目结论**: 记忆不挂这里; 常驻部分已由 `agent/session-start` 的指引 + pre-step 的 always-on 承担。

### 2.3 `tools/pre-execute` / `tools/post-execute` (工具前后)

- **能做什么**: 观察工具调用、记录审计、在失败后建议检索。
- **不能做什么**: 改不了模型已经决定的消息内容 —— 因此**不能用来保证记忆注入**。
- **候选用法**: 模型调用某个业务工具失败时, 由 post-execute 主动查一次记忆并给出提示 (下一步模型可见)。

### 2.4 为什么 `session/event` 不能用来注入

它是**只读广播**: 事件已经写进会话日志, 再往日志里塞内容不会改变本轮已发出的请求。
本项目用它做捕获 (`user/message` → turn → 记忆), 这是它正确的用途。

## 3. 与 VCP 的对照

|          | VCP                                                      | DSH (本项目)                                                                                              |
| -------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 声明方式 | Agent 模板里的日记占位符 `[[日记本::TagMemo+::Rerank+]]` | 项目绑定 (`bindings.json`) + 触发层意图库 <!-- verify-docs:allow (运行时数据文件, 只存在于记忆根目录) --> |
| 判定时机 | `processMessages` 请求前解析占位符                       | `agent/pre-step` waterfall                                                                                |
| 是否强制 | 有占位符即每轮注入                                       | always-on 保底无条件注入; 意图通道按句式门控                                                              |
| 门控手段 | 主题门控 / 动态 K / Truncate / Rerank                    | 意图置信度 / 话题漂移 / token 预算 / 内容级去重                                                           |
| 未配置时 | 无占位符 → 无记忆                                        | **仍有 always-on 保底** (这是本项目补的一环)                                                              |

**结论**: DSH 的 `agent/pre-step` 就是 VCP `processMessages` 的等价物, 且能力更强 (能读会话历史做去重、能按轮次决策)。
本项目已经挂上; 差别只在"未声明时是否有保底" —— 我们用 always-on 通道补上了。

## 4. 尚未使用但值得评估的点位

| 点位                     | 可能的用法                                    | 代价/风险                                    | 建议                                                 |
| ------------------------ | --------------------------------------------- | -------------------------------------------- | ---------------------------------------------------- |
| `tools/post-execute`     | 工具失败 → 主动检索相关踩坑经验, 注入下一轮   | 需要额外的注入通道 (post-execute 不能改消息) | 中优先: 用 pre-step 的"上一轮工具失败"状态实现更简单 |
| `agent/error`            | 出错时注入"以前遇到同类错误的处理"            | 错误路径上再加异步检索有放大风险             | 低优先                                               |
| `system-prompt/assemble` | 只放**稳定**的跨项目规则文本 (便于被宿主缓存) | 与 always-on 重叠, 且拿不到轮次语义          | 不采用 (职责重叠)                                    |
| `subagent/start`         | 给子 agent 注入"相关历史"                     | 污染委派语义 (子 agent 任务提示由父组织)     | 不采用 (已用 rootAgentsOnly 过滤)                    |

## 5. 证据 (宿主契约来源)

以下均为上游 `deepseek-ai/deepseek-harness` 仓库中的位置 (2026-09 核对):

- 轮次与步骤时序图: `docs/agent-lifecycle.md` —— 明确 `system-prompt/assemble` 与 `agent/pre-step` 都在 `step/start` 之前, `agent/request` 在其后。 <!-- verify-docs:allow (上游仓库路径) -->
- 事件作用域表: `packages/core/scope/src/scoped-events.generated.ts` —— 列出 `system-prompt/assemble` / `tools/*` / `subagent/*` 等的 scope 取参方式。 <!-- verify-docs:allow (上游仓库路径) -->
- `agent/pre-step` 的权威用法: `packages/context/session-reference/src/index.ts` (`await next()` 后返回 `{ kind: "enter", messages }`)。 <!-- verify-docs:allow (上游仓库路径) -->
- `system-prompt/assemble` 的权威用法: `packages/core/agent/src/model-selection.ts` (改写 `assembly.variables`)。 <!-- verify-docs:allow (上游仓库路径) -->
- 宿主侧 hook 插件: `packages/hooks/hooks-claude-code`、`packages/hooks/hooks-codex` —— DSH 自己就用插件点实现了外部 hook 的等价能力。 <!-- verify-docs:allow (上游仓库路径) -->

> 说明: 上表"本项目状态"以 `src/adapters/dsh/index.ts` 的 `ctx.on` 注册为准, 可由该文件直接核对。
