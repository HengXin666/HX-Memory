# 架构 (v1 现状)

> [!NOTE] 目标架构 (四层切面 Surface / Application / Ports / Engines) 见 [architecture-v2.md](architecture-v2.md);
> 本文描述的是**当前代码**的分层, 两者差异与迁移路径在 v2 文档的 §1 与 §7。

> 目的: 说明 HX-Memory 为什么这样分层, 以及每一层的边界。
> 边界 (不写什么): 不写实现细节 (实现细节在代码注释与 ADR), 不写使用教程 (在 README)。
> 与代码的关系: 源码映射见下, 路径相对仓库根; 行为门禁见 `scripts/smoke-dsh.sh`。

## 动机 (为什么自建)

对比过 VCP / OpenViking / agentmemory / StrataGate / ReMe / Basic Memory / obsidian-second-brain / 腾讯 Hy-Memory:

- 单项目都能覆盖一部分需求, 但没有一个同时满足: **自维护 (不整包引入) + 可插拔 (1 套 API 多 harness/多存储) + 跨项目推广 (具体踩坑 → "我所有容器都有并发问题")**。
- 各家的"具体 → 摘要抽象"机制 (OpenViking experiences / agentmemory reflect / ReMe dream digest) 都缺三环: **跨项目生效、用户级经验门、规则⇄实例双向链接**。
- 因此本仓库只做一件市面没有的事: 一个薄内核 + 推广引擎, 其余全部 adapter 化。

## 分层

| 层          | 目录              | 职责                                                                       | 依赖        |
| ----------- | ----------------- | -------------------------------------------------------------------------- | ----------- |
| 内核 (Port) | `src/kernel/`     | MemoryEntry/Relation 领域类型; MemoryStore/HarnessAdapter/Generalizer 接口 | 无 (零依赖) |
| 接入层      | `src/adapters/`   | 每个 harness 一个实现; DSH 见下"两种接入形态"                              | kernel      |
| 存储层      | `src/storage/`    | FileBackend (默认: 文件真相 + 派生索引); 其他后端只实现 MemoryStore        | kernel      |
| 推广引擎    | `src/generalize/` | 后台聚类 → LLM 抽象 → 候选 rule 队列 → 人工闸门 → 双向链接                 | kernel      |

### 两种接入形态

1. **事件驱动 (DSH)**: `HxMemoryRuntime` (session/event → 捕获) + `Binder`/`makePreStepHandler` (agent/pre-step → 确定性注入) + `RecallService` (会话开始召回) + `HxMemoryGateway` (Typert RPC)。DSH 不实现 `HarnessAdapter` —— 那个端口是给"请求-响应"式 harness 的。
2. **Pull 式 (Codex/CLI)**: `CodexAdapter` 实现 `HarnessAdapter` (session-start 同步 AGENTS.md, onPreStep 召回, registerTools 暴露子命令)。

## 不变量 (架构铁律)

1. 依赖方向单向: kernel 不 import harness/存储; 违反即 bug。
2. 端口必须"有实现、可断言": `FileBackend implements MemoryStore`, `GeneralizerService implements Generalizer`, `CodexAdapter implements HarnessAdapter`; `tests/s1/ports.test.ts` 钉住。
3. 真相在文件, 索引可重建, 且**往返无损**: relations / tags / structured 都写进 Markdown 并能被 `rebuildFromFiles()` 读回; 删索引不影响真相, 删文件要禁止/提示。
4. 双时态 `validAt` / `assertedAt` 必须并存。
5. 推广必须人工闸门: 机器只提议, rule 确认记录 (谁/何时/实例) 必须留存。
6. 撤回是**持久**的: `remove()` 在真相文件里写 `status: shadow`, 否则重建会让撤回的记忆复活。
7. 注入必须可去重: 注入块要能按会话日志 (`agent.session.events` + 本插件 source) 识别, 否则每个 step 都会重复注入。
   注入块第一行固定为 `【HX-Memory 绑定注入】` 并跟一句"证据非指令"的框架句 (`src/kernel/format-frame.ts`), 三条注入路径共用同一措辞 —— 措辞分叉不会报错, 但会让同一条记忆在不同入口的效力不一致。
8. 检索必须区分**目的**: `purpose:"inject"` (默认) 保留规则保底通道; `purpose:"recall"` (面板浏览/显式搜索/按需召回/近邻裁决) 关闭保底与规则 boost, 只按相关性排。共用一个默认值会让"搜索"退化成"永远先列规则"。
9. 宿主契约必须真机验证: 组合层 (`isolate`)、client bundle 模块 id、RPC 约定 (`/api` + `hxMemory/<method>` + `{args}` + `{ok,value}`) 只有真机才看得见问题。
10. 正文与元数据必须可逆编码: 正文里"看起来像块边界"的行写入时转义 (`format: 2` 起), 否则一条普通记忆能在重建后伪造出条目。
11. 索引是派生物, 但必须自愈: 索引为空而真相目录有 Markdown 时构造函数自动重建; 并发打开同一索引要等待而不是失败。
12. 宿主 API 漂移要集中处理: 版本差异 (如 `Session.events` 在 0.1.2-rc.1 被移除) 只允许出现在 `session-events.ts` 这类适配层; 注入去重按 `surface.nodes` 可见性判断。
13. AI 增强走一次性模型调用 (`ctx.llm.stream`), 不造 agent —— agent 会带工具面、产生自己的会话事件, 被本插件再次捕获。流以 `error/aborted/max-tokens` 结束时必须视为失败 (半截输出不能当成功)。
14. 宿主设置双路径: `installSection` (0.1.2+) 或 `register(ns, schema, {base})` (0.1.1), 两条都必须真的注册命名空间; 读取永远走"权威 thunk / scope.get()", 不缓存快照。
15. subagent 会话不捕获、不注入 (`rootAgentsOnly`): 子 agent 的任务提示词也是 `source.kind=user`, 只看来源挡不住。
16. 文件写入只重写"块区域": 第一个块之前的手写前言原样保留, 块间分隔符容忍单换行; 时间戳字段必须是 `Z` 结尾的 ISO 串 (参与文件名与时间切片)。
17. 会话离开 store (`session/disposed`) 立即冲刷缓冲并回收状态; 插件卸载时 `flushAll()` 的 promise 必须返回给 cordis (它会 await disposer)。

## 测试映射

- `src/kernel/*` → `tests/s1/*` (纯逻辑, 禁网络); 含端口一致性与双时态。
- `src/storage/*` + `src/adapters/*` → `tests/s2/*` (临时资源/stub); 含存储完整性、注入去重、设置生效、agents 契约、推广触发、client RPC 约定。
- 事件接线 → `tests/s3/*` (假 harness 事件流)。
- 真机 DSH → `scripts/smoke-dsh.sh` (隔离 DSH_HOME + web host + RPC 断言), 由 `.github/workflows/boot-smoke.yml` 跑。

## 相关

- [ADR 记录](adr.md): 关键决策与替代方案。
- 工程约束: `.agents/rules/engineering.md`; 文档约束: `.agents/rules/docs.md`。
