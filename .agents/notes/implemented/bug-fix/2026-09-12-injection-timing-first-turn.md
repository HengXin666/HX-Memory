# Agent Note: 注入时机可配置 (首轮一次 vs 逐轮差量)

Status: implemented

## Problem

用户实测反馈: "他好像还是在每轮对话的时候都给我注入一个记忆, 我不理解为什么要这样做?
我只需要在第 1 轮的时候注入一下"。日志里能复现这个体感 —— 但原因不是"轮次策略错了",
而是**首轮判重失效**, 让每一轮都看起来像在注入新东西。

三条真实证据 (本机 `~/.dsh/sessions`, 解析 `user/message` 且 `source.plugin = hx-memory`):

1. **首轮必然重发一份**: `session-54bf3f3b` 的 turn 1 有两个注入块 (seq 10 长 1439, seq 12 长 1362),
   两块各带 8 个条目 id, 其中 6 个逐字相同 (`r6797a474a4024219` 等)。
   `session-4cdbd34a` 同样: seq 10 与 seq 12 各 8 个 id, 完全重合。
2. **根因是时序, 不是判重算法**: 会话开始用 `agent.inject()` 把块投进 inbox
   (`agent/inbox/spliced target=next-step`), 它的 `user/message` 事件要等这一步的 claim 批次
   写进会话日志后才出现; 而 `agent/pre-step` 在**那之前**运行 (`dsh-agent-loop` 的 `turn()`:
   `inbox.claim()` → `dispatch.waterfall("agent/pre-step")` → step 结束才 append)。
   于是 `scanPriorInjections` 在首轮看不到会话开始那份块, 差量基线是空的 —— 必然重发。
3. **之后仍有"看起来每轮都在注入"**: 差量本身工作正常 (只有新 id 会发), 但 always-on 池会随
   人审确认/规则演进而变 (`m24b75606e44947aa`、`cde8a43baf2e2e52b` 等新条目出现),
   于是后续轮次持续有小块新条目到达。对用户而言这与"每轮都注入"无法区分。

## Decision

两件事, 一个修缺口, 一个给开关:

1. **判重基线并入本轮 claimed 批次** (`prestep.ts` 的 `collectInjectionEntries`):
   把 `payload.messages` 与 `decision.messages` 里本插件的注入块也并进 `texts/ids`。
   这两批都是"模型即将看见的内容", 口径与"已注入"完全一致 —— 会话开始那份块因此在
   首轮就计入基线, 同一批常驻记忆只出现一次。
2. **新增设置 `injectMode`** (`"every-turn" | "first"`, 默认 `every-turn`):
   - `every-turn` = 现状的差量策略 (只补本会话还没有的条目);
   - `first` = 只要本会话已经出现过**记忆条目块**, 预步就不再进入注入通道 (连检索都不做)。
   - 开关的判据是"有没有带 id 的条目块" (`scanPriorInjections(...).ids.size`), 不是
     "本插件注入过任何东西": 会话开始同时注入**指引块** (无 id) 与条目块, 用后者会让
     "库里没有不变量"的会话在首轮反而不注入 —— 恰好丢掉"模型没意识时的唯一保底"
     (r00155cdb954e41c7)。
   - 设置经 `settingsSource` thunk 每次读取, 面板改动**当轮**生效 (不重启)。
3. **在界面上可改**: 宿主只渲染"服务端提供的命名空间 ∩ 有卡片认领的命名空间"
   (`dsh-client-ui-settings-plugins` 的 `ConfigurablePluginsTabController`), 因此新增
   `client/register-card.ts` + `client/injection-card.tsx`, 注册到 `settings.plugin.item`
   且 `key = "hx-memory"`。卡片走宿主的 `settingsScope.bind({namespace})` 写权威设置
   (带 revision 栅栏), 不走自家 gateway RPC —— 两套写路径会互相覆盖, 且绕开宿主的校验与
   冲突恢复。宿主没有 ui-settings 插件时卡片缺席 (经 `ctx.get("settingsScope")` 探测,
   不写进 `inject` 数组以免强制依赖), 其余面板照常工作。
   scope 的解析刻意**推迟到渲染时**: 客户端插件之间没有声明依赖, apply 完全可能与
   ui-settings 的加载交错 —— 在 apply 时就要求 scope 存在, 会让拿到 undefined 的插件
   **永远**没有卡片, 而且不报错 (`register-card.ts` 里说明了这条, 并有针对性用例)。
   注册逻辑与显示判定刻意留在**无 JSX 的 .ts** 里 (`register-card.ts`/`injection-mode.ts`):
   node 环境的测试只要 import 到 .tsx, 整棵组件树就会被拉进 kernel 的 tsc 程序, 而那份
   tsconfig 不含 DOM lib —— 结果是一屏 "Cannot find name 'document'"。

## Alternatives considered

- **默认就改成 `first`**: 会话中途出现的"上次我们怎么做的"这类提问会拿不到具体历史,
  而 r00155cdb954e41c7 要求保底通道**无条件** —— 默认 `first` 是拿保底换安静。**否掉**:
  先修首轮判重 (那才是用户体感的来源), 把静默权交给用户自己开。
- **只做设置不做判重修复**: 用户开着 `every-turn` 时首轮仍然双份, 且"每轮都在注入"里
  有一份纯粹是重复。**否掉** —— 开关不是修复。
- **在内存里记"本会话已注入"计数器**: 预步可能被并发调用 (subagent/并行步), 内存计数会漏判,
  且 compaction 遮蔽后无法自救 (看不到历史就永远沉默)。**否掉** —— 基线必须来自
  "模型可见的会话历史", 这正是既有 `scanPriorInjections` 的口径。
- **用"本插件是否注入过"当开关**: 见 Decision 第 2 条, 会把指引块误判成记忆块。**否掉**。
- **让卡片走自家 RPC 写设置**: 见 Decision 第 3 条。**否掉**。
- **把常驻块挪进 system prompt**: 仍然是同一个取舍 (DSH 插件没有稳定的 system 写入点),
  且与本次诉求 (少重复) 无关。**不做**, 见 Consequences。

## Consequences

换来的: 首轮不再双份; 用户可以在界面上选择"只在首轮注入一次"并**当轮**生效;
两种模式都不影响 `memory_search` 工具 (它在两种模式下都常开)。

付出的:
- `first` 模式下, 会话中途的话题切换不会再自动带来记忆 —— 模型需要自己调 `memory_search`
  (指引块在会话开始时已给出这条路径)。这是用户明确要的取舍, 但它确实是能力的减少;
- 基线仍依赖"会话历史里能找到自己的注入": compaction 遮蔽后 `ids` 会退化 → 行为变成
  重新注入 (保守但正确, 不会永久沉默);
- 卡片只在宿主装了 ui-settings 时出现; 没有它就只剩插件配置 (entry) 可改 ——
  刻意为之: 不为一张可选卡片把 ui-settings 变成硬依赖。

## Testing

- `tests/s2/prestep-dedupe.test.ts`: claimed 批次并入基线 (首轮不重发)、`first` 模式关闸、
  "只有指引 (无 id) 时首轮仍注入"、scan 接受 Session 或 Agent。
- `tests/s2/settings-live.test.ts`: 面板把 `injectMode` 改成 `first` → 当轮停止注入; 切回
  `every-turn` 当轮恢复 (真库 + 真绑定, 不是空库的空断言)。
- `tests/s2/injection-dedupe.test.ts`: id 标记解析、组切分、差量注入 (既有回归)。
- `tests/s2/client-injection-card.test.ts`: 卡片以 `key = "hx-memory"` 认领 (key 错 = 开关
  在界面上消失)、宿主没有 settingsScope 时静默缺席、显示判定不谎报 `first`、
  "写成功"以回调后读回的权威值为准、中英字典键集合一致。
- `scripts/smoke-dsh-http.mjs` (真机): `settings/describe` 的 schema 必须含 `injectMode`、
  默认值是 `every-turn`, 并且 `settings/update` 写入后重新 describe 能读回 `first`。
  另有一次性实录: 对真宿主调 `settings/update` 后, 插件的 `onChange` 钩子里读到的
  `injectMode` 就是 `first` —— 证明面板写路径确实当轮触达插件。
- 真实会话证据: `session-54bf3f3b` (首轮双份, 6/8 id 重复)、`session-4cc79f1c` (14 轮 8 次注入)、
  `session-4cdbd34a`; 事件形状与 seq 记录在 Problem 里。
