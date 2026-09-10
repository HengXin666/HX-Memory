---
name: hx-record-session-replay
description: 用"录制一次真实会话 → 之后离线回放"的方式为宿主接线 (DSH 插件点、注入去重、设置生效、子进程 stdio) 写可重复的回归证据。当你要验证的行为依赖真实宿主时序、DOM、进程边界或插件组合时使用它; 纯逻辑断言不要用它。
---

# 会话录制与回放 (宿主接线的可重复证据)

真实宿主行为 (插件组合、waterfall 顺序、注入去重、设置热更新) 用 mock 测不出来 ——
但每次现场手测又不可重复。做法是**录一次、回放多次**。

## 何时用

- 行为依赖**真实宿主的时序** (agent/pre-step 与 system-prompt/assemble 的先后、去重是否跨 step 生效);
- 行为跨**进程边界** (CLI/MCP stdio、跨进程共享索引);
- 行为依赖**插件组合** (isolate、模块 id、RPC 约定);
- 要回归一个**曾经只在本机复现**的 bug (存储层损坏、设置不生效)。

纯函数/内核逻辑用普通单测 (S1), 不要走录制 —— 回放的成本换来的是"接近真机", 不是更快。

## 录制什么

录制产物是**事件序列**, 不是截图或日志文本:

1. 输入帧: 宿主推给插件的事件 (session/event、agent/pre-step 的 payload、stdin 的 JSON-RPC 行);
2. 断言点: 插件产生的**可观察副作用** (注入的消息文本、写盘的真相文件、RPC 响应);
3. 元数据: 宿主版本、Node 版本、插件版本 (版本漂移时回放失败要能一眼看出是环境变更而非逻辑回归)。

本仓库的既有录制点 (可直接复用):

| 回放目标                   | 现有文件                           | 录制内容                                        |
| -------------------------- | ---------------------------------- | ----------------------------------------------- |
| 捕获 → 落盘 → episode 血缘 | `tests/s2/episode-capture.test.ts` | 事件序列 (turn/start → user/message → turn/end) |
| 设置热更新                 | `tests/s2/settings-live.test.ts`   | 可变设置源 + 同一条事件序列                     |
| 跨进程索引                 | `tests/s2/cross-process.test.ts`   | 子进程脚本 + 并发时序                           |
| MCP stdio                  | `tests/s2/mcp-surface.test.ts`     | 换行分隔的 JSON-RPC 帧                          |
| 真机 DSH                   | `scripts/smoke-dsh.sh`             | 隔离 DSH_HOME + 起 web host + RPC 断言          |

## 回放的三条纪律

1. **回放不联网**: 需要模型的地方注入假模型 (一次性函数), 否则回放会变成 flaky 测试。
2. **回放要能失败**: 断言必须钉住"会出问题的那一点" (例如去重失败会看到同一条被注入两次),
   而不是只断言"进程退出码 0"。退出码 0 是最弱的证据。
3. **录制文件要能读**: 事件序列用 JSON 存放并进 git (`tests/fixtures/` 或内联常量),
   这样回归时能 diff 出"哪一帧变了"。

## 写一个回放测试的最小骨架

```ts
// 1) 录制: 事件帧 + 期望副作用 (内联或 fixtures/*.json)
const FRAMES = [
  { type: "turn/start", data: {} },
  {
    type: "user/message",
    data: { source: { kind: "user" }, content: [{ type: "text", text: "踩坑: ..." }] },
  },
  { type: "turn/end", data: { reason: { kind: "completed" } } },
];
// 2) 回放: 把帧喂给真实实现 (不是 mock 实现)
for (const frame of FRAMES) await runtime.capture(session, frame);
// 3) 断言可观察副作用 (not 退出码)
expect(store.query({ kind: "lesson" }).length).toBe(1);
```

## 反模式 (踩过的)

- **只断言"没抛错"**: 静默失效 (例如 capture 签名错了导致什么都不做) 会假通过 —— 本仓库真踩过。
- **回放里用真实模型**: 慢且不稳定; 用假模型 + 固定响应。
- **把回放当单测用**: 它慢且依赖环境; 单测能覆盖的逻辑不要塞进回放。
