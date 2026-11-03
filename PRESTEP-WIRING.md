# PRESTEP-WIRING — task-state 接进 prestep

## 1 结论

裸「继续 / next / 嗯 / yes」现在能推出「继续什么」: 只要会话历史里有一轮带明确动作词的用户话, prestep 注入块里就会出现「【当前任务】用户本轮只说「继续」= 继续上一任务「…」(动作: …; 涉及 …; 未闭合的失败: …)」, 记忆库为空也照样注入; 历史里没有明确上一动作时不注入、不伪造。
但要如实说明: 账本那 39 行 **没有一行是裸「继续」** (见第 5 节), 新逻辑让其中 13 行的注入块与旧块不同 (不再被判重挡掉), 其余 26 行仍与旧块相同。

## 2 改了哪些文件

本次未改 src/kernel/task-state.ts 与 src/kernel/task-continuation.ts, 只接线, 接线在 src/adapters/dsh/prestep.ts。也没碰 src/trigger/intents.ts、dist/、tsconfig、评测集、面板与前几轮报告, 没有 git 提交。

| 文件 | 行 (改后) | 改了什么 / 为什么 |
|---|---|---|
| src/adapters/dsh/prestep.ts | 39-40 | import computeTaskState / TaskState (kernel/task-state.ts) 与 sessionEvents (./session-events.js) |
| src/adapters/dsh/prestep.ts | 42-56 | 新增 `historyForTaskState(session, claimed)`: 全量历史 = sessionEvents 的 user/message、assistant/message(.message)、tool/result(.message) 转成 DSH message 形状, 再并上本步 claimed 批次 (按 id 去重)。不新造 IO |
| src/adapters/dsh/prestep.ts | 58-72 | 新增 `taskStateLine(state, text, lang)`: 续接短句且有 previousAction → 「继续什么」行, force=true (没有记忆条目也单独成块); 续接短句但无 previousAction → 空 (不伪造); 非续接轮 → 仅当 goal 非空且 confidence ≥ 0.4 时附「【当前任务】goal」, force=false (只随已有块附带, 不单独成块)。blockedOn 只在 previousAction 存在时出现 |
| src/adapters/dsh/prestep.ts | 202-203 | 选项 `taskState?: () => boolean` (默认开, false 关闭; 便于回滚/对照) |
| src/adapters/dsh/prestep.ts | 301-310 | 原 266 行 `const extra = …` 处: 调 computeTaskState + taskStateLine (try/catch, 失败不拖垮注入); force 的行并进 extra, 所以「库里没条目 + 用户说继续」也会发块 |
| src/adapters/dsh/prestep.ts | 361 | 原 317 行 composeMemoryBlock 的 body 改为 `[task.line, bound, sideBody]`: 当前任务行排在条目之前, 同一个块 |
| src/adapters/dsh/prestep.ts | 373 | `if (prior.texts.has(injectedText))` 判重**原样保留**。块文本现在随任务状态变化, 所以同一句话在不同任务状态下不再被误杀, 同一状态下照常去重 |
| tests/kernel/prestep-task-state.test.ts | 新文件 | 6 条单测 (第 4 节) |
| .hark-tmp/prestep-wiring-replay.ts, .hark-tmp/js2ts-loader.mjs | 新文件 (临时目录) | 演示 / 39 行回放 / 3 样例的证据脚本; loader 只为让 `node --experimental-strip-types` 能解析源码里写成 .js 的相对 import |

位置说明: 任务书要求「在算出 injectedText 之后、判重之前」并入。实际放在 extra 处 (injectedText 之前), 因为 prestep 在 bound/extra 都为空时会提前 return (不发块); 若在 injectedText 之后才并, 「库里没条目 + 用户说继续」这种最需要的情况根本走不到那一步。并入结果仍在同一个块里, 且在判重之前。
prestep.ts 改后 399 行, `verify-structure` 通过 (≤ 400 行上限)。

## 3 全量历史从哪来

- 模块: src/adapters/dsh/session-events.ts, 函数 `sessionEvents(session)` (已有, 版本无关; 0.1.2+ 走 eventAt(surface.nodes), 否则 snapshotEvents() → events → ownEvents(), 并按 surface 过滤 compaction 遮蔽的事件)。injection-dedupe.ts 的 `scanPriorInjections` 与 receipt.ts 用的就是它。
- 接线: prestep.ts `historyForTaskState(agent.session, payload.messages)` → `computeTaskState({ cwd: agent.session.header.cwd, messages, project })`。
- 本步 claimed 批次 (当前用户这句话还没写进日志) 按 id 去重后追加在末尾。
- 插件注入的 role:user 块 (记忆块、AGENTS.md 基线) 由 task-state 自己的 isInjected 过滤, 不会被当成任务信号。
- 没有用 ~/.dsh/sessions 的 jsonl 作权宜数据源: 生产路径读的是 session 对象本身。jsonl 只在回放/样例脚本里用 (离线复现)。

## 4 单测 (tests/kernel/prestep-task-state.test.ts)

走真实 makePreStepHandler + 空库 Binder (`new Binder(() => [], () => [])`), 历史用真实事件形状喂 session.events。

- a `历史有明确上一动作 → 注入块里出现上一动作与涉及文件`: 块非空, 含「【当前任务】」「动作: 修改」「src/trigger/policy.ts」与上一轮原话。
- b `历史空白 → 不注入, 不伪造上一任务`: 块为 null; taskStateLine 返回 { line: "", force: false }。
- c `同一句「继续」在两个任务状态下文本不同, 且判重不再误杀`: 两个历史下文本不同; A 的块已在会话日志时切到 B 再说「继续」仍注入且等于 B 的块; B 的块已在日志时再说「继续」→ null (判重照常)。
- d `previousAction 为空时 blockedOn 不许出现`: 只有报错没有动作词 → 块为 null, state.previousAction/blockedOn 均为 null; 人为塞入 blockedOn 时 taskStateLine 仍返回空行。
- e `有上一动作且其后工具报错未修复 → blockedOn 随块出现`: 块含「未闭合的失败: ECONNREFUSED」与「用户本轮只说「next」」。
- f `historyForTaskState: 会话事件 + claimed 批次按 id 去重, 跳过非消息事件`。

### npx vitest run tests/kernel/ (exec 直接跑, 退出码 0)

```
code= 0 ok= True

 RUN  v3.2.7 /home/hx/Loli/code/HXLoLis/components/HX-Memory

 ✓ tests/kernel/task-state.test.ts (18 tests) 27ms
 ✓ tests/kernel/prestep-task-state.test.ts (6 tests) 14ms

 Test Files  2 passed (2)
      Tests  24 passed (24)
   Start at  21:55:30
   Duration  474ms (transform 179ms, setup 0ms, collect 246ms, tests 41ms, environment 0ms, prepare 219ms)
```

### npx vitest run (全量, exec 直接跑, 退出码 0)

```

 ✓ tests/s1/external-perf.test.ts (1 test) 5728ms
   ✓ 外置宿主性能 > 词面投影上的保留、召回、挫折、文档和重放都有预算  5726ms
 ✓ tests/eval/concurrency.test.ts (4 tests) 6358ms
   ✓ P0 跨进程并发 (M5) > 两个进程各写 200 条: canonical 与 FileBackend 都是 400 条, 0 解析错误  2292ms
   ✓ P0 跨进程并发 (M5) > canonical: 写入中途被 SIGKILL, bundle.json 仍是完整 JSON, 之后照常写入  1561ms
   ✓ P0 跨进程并发 (M5) > FileBackend: 写入中途被 SIGKILL, 真相文件全部可解析, 之后照常写入  2251ms

 Test Files  200 passed (200)
      Tests  1508 passed (1508)
   Start at  21:55:39
   Duration  7.19s (transform 8.47s, setup 0ms, collect 60.50s, tests 31.23s, environment 65ms, prepare 24.01s)
```

(全量运行的 stderr 里有 verify-docs 对 docs/_probe-broken-ref.md 的提示与一行「找不到记忆根或 profile」, 都是既有测试故意构造的失败探针输出, 不是失败用例; 200 个文件全部 passed。)

### npx tsc --noEmit (退出码 2)

```
code= 2 ok= False
src/kernel/task-state.ts(173,21): error TS2550: Property 'findLastIndex' does not exist on type 'string[]'. Do you need to change your target library? Try changing the 'lib' compiler option to 'es2023' or later.
src/kernel/task-state.ts(173,36): error TS7006: Parameter 'd' implicitly has an 'any' type.
src/kernel/task-state.ts(186,19): error TS2550: Property 'findLastIndex' does not exist on type 'string[]'. Do you need to change your target library? Try changing the 'lib' compiler option to 'es2023' or later.
src/kernel/task-state.ts(186,34): error TS7006: Parameter 'd' implicitly has an 'any' type.
```

这 4 条全部在 src/kernel/task-state.ts (findLastIndex), 原因是磁盘上 tsconfig.json 的 lib 仍是 ["ES2022"] (mtime 2026-11-01 21:10), 「另一路改成 ES2023」在本轮检查时还没落盘。prestep.ts 与新测试文件没有任何 tsc 报错。我没有动 tsconfig (不在本轮范围)。

## 5 39 行账本回放

数据: /home/hx/.dsh/hx-memory/schedule/*.jsonl 里 mode=always-on, intent=session-continuation, outcome=skipped 的 39 行 (5 个会话)。账本行本身没有用户文本, 所以按 session + step + 时间 (CST 分钟) 在会话日志 (~/.dsh/sessions/…/session.v3|v4.jsonl.zstd) 里定位 step/start, 39 行全部定位成功; 取该 step 之前的事件为历史, 最后一条直接用户消息为当轮文本。
做法: 条目正文 = 当时会话里最近一次记忆块去掉标题/框架句 (当时召回的就是同一批常驻条目); 用 stub Binder 返回这份正文, 把 composeMemoryBlock(正文) 作为「已注入过的块」放进会话日志, 然后同一份输入跑两遍 prestep: taskState 关 (改造前) / 开 (改造后)。同一会话里改造后已注入的块也会累积进判重基线。

结果 (39 行):
- 改造前: 39/39 outcome=skipped (复现了账本)。
- 改造后: 13/39 outcome=injected, 注入块 hash 与旧块不同; 26/39 仍 skipped。
- 39 行里裸续接短句 (继续/next/嗯/yes…) 的数量: 0。这 39 行是 intents.ts 的 session-continuation 正则命中的长句 (「你先开始做吧…」「所以你应该继续改呀，重构」…), 不是裸「继续」。
- 26 行仍相同的原因: task-state 判这些句子既不是续接短句 (isContinuationUtterance 只认 ≤6 字或词表), 当轮也没有「动作词 + 路径」, confidence < 0.4, 所以不附当前任务行 (这是有意的门槛: 低可信度的 goal 附上去就是噪声)。
- 已知噪声: 改造后的 goal 用了 task-state 的 actionOf, 例如「完全没有审美，太丑了…」被判成「排查」(含「看」字), 「最近报错 Error」常来自工具输出里的普通 Error 字样。这是 task-state 内部词表行为, 本轮按要求不改。

完整对照 (before/after 注入块 sha256 前 12 位 + 改造后当前任务行前 80 字):

```
=== REPLAY rows=39
#1 27796741 step=1 at=2026-09-27 22:42 user=「你先开始做吧，到时候我们我们自己来维护这个，他这个可能也不不是很符合我们的需求，」
   before: outcome=skipped hash=46eb5c12e90a  | after: outcome=skipped hash=-
   after 当前任务行前80字: (无块)
#2 27796741 step=2 at=2026-09-27 22:43 user=「还是看不清，你这个配色本身就不对，哪有人会用白色做外描边，然后内部是黄色这种配色」
   before: outcome=skipped hash=46eb5c12e90a  | after: outcome=injected hash=1fdd7438d574
   after 当前任务行前80字: 【当前任务】在 hx/kfx-work、automation/autoload 排查, 最近报错 Error
#3 27796741 step=1 at=2026-09-27 22:53 user=「你先去彻底的学习一下怎么配色？」
   before: outcome=skipped hash=46eb5c12e90a  | after: outcome=skipped hash=-
   after 当前任务行前80字: (无块)
#4 b3c1d3d0 step=3 at=2026-09-27 22:53 user=「接着做并行的做 然后的话还缺少了代码块这个控件, 我建议直接使用 vscode 」
   before: outcome=skipped hash=e26fc13b7d58  | after: outcome=skipped hash=-
   after 当前任务行前80字: (无块)
#5 b3c1d3d0 step=1 at=2026-09-27 22:57 user=「你这个代码块使用的字体也不对 你应该用写代码，专门用的那种字体啊」
   before: outcome=skipped hash=e26fc13b7d58  | after: outcome=skipped hash=-
   after 当前任务行前80字: (无块)
#6 b3c1d3d0 step=9 at=2026-09-27 23:00 user=「这个加载的动画可以换一个吗？」
   before: outcome=skipped hash=e26fc13b7d58  | after: outcome=injected hash=a624cb59f910
   after 当前任务行前80字: 【当前任务】在 src、src/pages 新增
#7 b3c1d3d0 step=1 at=2026-09-27 23:05 user=「没有任何动效啊，你去网络上去参考一些啊」
   before: outcome=skipped hash=e26fc13b7d58  | after: outcome=skipped hash=-
   after 当前任务行前80字: (无块)
#8 b3c1d3d0 step=1 at=2026-09-27 23:09 user=「完全没有审美，太丑了，太太难看了，太难看了，太难看了，太难看了，你去网上偷你去网」
   before: outcome=skipped hash=e26fc13b7d58  | after: outcome=injected hash=7dbd9e9dcc6c
   after 当前任务行前80字: 【当前任务】在 src、apps/desktop 排查
#9 b3c1d3d0 step=2 at=2026-09-27 23:10 user=「算了，还是换吧，操你妈的换回去那种朴素的加载效果就可以了」
   before: outcome=skipped hash=e26fc13b7d58  | after: outcome=injected hash=7e88a88bbafe
   after 当前任务行前80字: 【当前任务】在 src、apps/desktop 新增
#10 b3c1d3d0 step=3 at=2026-09-27 23:10 user=「别写你的傻逼，这个标志了，难看的要死」
   before: outcome=skipped hash=e26fc13b7d58  | after: outcome=skipped hash=-
   after 当前任务行前80字: (无块)
#11 b3c1d3d0 step=1 at=2026-09-27 23:14 user=「你换个史莱姆，在这跳都可以啊」
   before: outcome=skipped hash=e26fc13b7d58  | after: outcome=skipped hash=-
   after 当前任务行前80字: (无块)
#12 b3c1d3d0 step=1 at=2026-09-27 23:18 user=「没有对齐 阴影没有对齐而且我想要的是转生史莱姆的那个史莱姆的那种效果」
   before: outcome=skipped hash=e26fc13b7d58  | after: outcome=skipped hash=-
   after 当前任务行前80字: (无块)
#13 b3c1d3d0 step=1 at=2026-09-27 23:21 user=「我要那种弹几下能变形的那种感觉，能不能做出来？」
   before: outcome=skipped hash=e26fc13b7d58  | after: outcome=skipped hash=-
   after 当前任务行前80字: (无块)
#14 b3c1d3d0 step=13 at=2026-09-27 23:27 user=「不是我要那种变形的，你可以去看一下那个动画吗？转生史莱姆」
   before: outcome=skipped hash=e26fc13b7d58  | after: outcome=injected hash=5dce295c9310
   after 当前任务行前80字: 【当前任务】在 src、src/primitives 排查
#15 b3c1d3d0 step=16 at=2026-09-27 23:29 user=「我要能看到就是液体能分离的那种，就是下落的时候，有一些液体是能分离的。然后我还要」
   before: outcome=skipped hash=e26fc13b7d58  | after: outcome=skipped hash=-
   after 当前任务行前80字: (无块)
#16 27796741 step=1 at=2026-09-27 23:29 user=「维护1套本地的规则，文件文档，让你日后都能使用」
   before: outcome=skipped hash=46eb5c12e90a  | after: outcome=skipped hash=-
   after 当前任务行前80字: (无块)
#17 27796741 step=2 at=2026-09-27 23:29 user=「所以你应该继续改呀，重构」
   before: outcome=skipped hash=46eb5c12e90a  | after: outcome=injected hash=0785e60299af
   after 当前任务行前80字: 【当前任务】在 hx/kfx-work、automation/autoload 修改, 最近报错 Error
#18 b3c1d3d0 step=22 at=2026-09-27 23:30 user=「https://www.reddit.com/r/TenseiSlime/com」
   before: outcome=skipped hash=e26fc13b7d58  | after: outcome=skipped hash=-
   after 当前任务行前80字: (无块)
#19 b3c1d3d0 step=23 at=2026-09-27 23:30 user=「https://packaged-media.redd.it/6txhesnba」
   before: outcome=skipped hash=e26fc13b7d58  | after: outcome=skipped hash=-
   after 当前任务行前80字: (无块)
#20 b8518921 step=1 at=2026-09-27 23:33 user=「当然还有健全」
   before: outcome=skipped hash=e26fc13b7d58  | after: outcome=skipped hash=-
   after 当前任务行前80字: (无块)
#21 d673409a step=1 at=2026-09-27 23:33 user=「写 Agent Note + 提交 目前这个东西有接入到 gh-r 这个服务里面」
   before: outcome=skipped hash=7886b497d8fd  | after: outcome=skipped hash=-
   after 当前任务行前80字: (无块)
#22 d673409a step=1 at=2026-09-27 23:38 user=「直接新建一个服务吧, 当然跟原本的功能是一样的，只不过新建的我们更好掌控一点。然」
   before: outcome=skipped hash=7886b497d8fd  | after: outcome=skipped hash=-
   after 当前任务行前80字: (无块)
#23 b3c1d3d0 step=1 at=2026-09-27 23:39 user=「你必须参考这个明明就是有五官的你妹的」
   before: outcome=skipped hash=e26fc13b7d58  | after: outcome=skipped hash=-
   after 当前任务行前80字: (无块)
#24 27796741 step=1 at=2026-09-27 23:40 user=「我的ASS可用的都没出来呢，你为什么不继续做？」
   before: outcome=skipped hash=46eb5c12e90a  | after: outcome=injected hash=9dceba7ef3e3
   after 当前任务行前80字: 【当前任务】在 hx/kfx-work、share/hx-kfx 排查, 最近报错 Error
#25 b3c1d3d0 step=1 at=2026-09-27 23:42 user=「没有动画啊」
   before: outcome=skipped hash=e26fc13b7d58  | after: outcome=skipped hash=-
   after 当前任务行前80字: (无块)
#26 27796741 step=1 at=2026-09-27 23:45 user=「你为什么放在这种地方？这种地方全宇宙谁能加载的到你这个傻逼规则库 我自己都找不到」
   before: outcome=skipped hash=46eb5c12e90a  | after: outcome=injected hash=70892abba662
   after 当前任务行前80字: 【当前任务】在 hx/kfx-work、py/ass 排查, 最近报错 failed
#27 27796741 step=5 at=2026-09-27 23:46 user=「你自己找一个啊, ~/Loli/code/HX-Music 这里就有现成的项目，」
   before: outcome=skipped hash=46eb5c12e90a  | after: outcome=injected hash=5ede806667b5
   after 当前任务行前80字: 【当前任务】在 hx/kfx-work、py/ass 排查, 最近报错 报错
#28 c5644e70 step=1 at=2026-09-27 23:47 user=「https://github.com/maliaosaide/aether-se」
   before: outcome=skipped hash=e26fc13b7d58  | after: outcome=skipped hash=-
   after 当前任务行前80字: (无块)
#29 d673409a step=1 at=2026-09-27 23:54 user=「账号只留活的其他不管 协议库放新的地方直接移动 前端必须重写，必须重写, 因为当」
   before: outcome=skipped hash=7886b497d8fd  | after: outcome=injected hash=06be09eaa73b
   after 当前任务行前80字: 【当前任务】在 workspaces/browser-auto、.agents/tools 修改, 最近报错 failed
#30 d673409a step=18 at=2026-09-27 23:56 user=「这个你有注册到 hx-webx 这个里面吗？把它注册为一个服务组」
   before: outcome=skipped hash=7886b497d8fd  | after: outcome=skipped hash=-
   after 当前任务行前80字: (无块)
#31 c5644e70 step=1 at=2026-09-27 23:57 user=「https://github.com/konbakuyomu/smartsear」
   before: outcome=skipped hash=e26fc13b7d58  | after: outcome=skipped hash=-
   after 当前任务行前80字: (无块)
#32 27796741 step=1 at=2026-09-27 23:58 user=「然后把你你这个步骤提炼出来，然后现在非常要注意的就是歌词是否能和这个字幕时间轴对」
   before: outcome=skipped hash=46eb5c12e90a  | after: outcome=skipped hash=-
   after 当前任务行前80字: (无块)
#33 b3c1d3d0 step=1 at=2026-09-27 23:58 user=「你变的都是什么狗屎啊？根本就不行，根本就不行，根本就不行，根本就不行，你自己不会」
   before: outcome=skipped hash=e26fc13b7d58  | after: outcome=skipped hash=-
   after 当前任务行前80字: (无块)
#34 d673409a step=1 at=2026-09-27 23:59 user=「另外我没有这个前端的凭证，另外前端你应该给一个这个图标，给他网页图标啊」
   before: outcome=skipped hash=7886b497d8fd  | after: outcome=skipped hash=-
   after 当前任务行前80字: (无块)
#35 d673409a step=1 at=2026-09-28 00:02 user=「而且为什么前端好像直接丢失了CSS？」
   before: outcome=skipped hash=7886b497d8fd  | after: outcome=injected hash=3bcdfd817cb1
   after 当前任务行前80字: 【当前任务】在 workspaces/browser-auto、.agents/tools 排查, 最近报错 报错
#36 d673409a step=1 at=2026-09-28 00:10 user=「我说你这个前端怎么做的这么难看」
   before: outcome=skipped hash=7886b497d8fd  | after: outcome=injected hash=e35788a87fe3
   after 当前任务行前80字: 【当前任务】在 workspaces/browser-auto、.agents/tools 排查, 最近报错 failed
#37 d673409a step=26 at=2026-09-28 00:14 user=「pattaponkumsoontorn321 这个账号是今天用协议注册的，他还活」
   before: outcome=skipped hash=7886b497d8fd  | after: outcome=injected hash=431885aeae65
   after 当前任务行前80字: 【当前任务】在 workspaces/browser-auto、.agents/tools 新增, 最近报错 Error
#38 27796741 step=1 at=2026-09-28 00:15 user=「对的，你做完 然后对于这个歌词的这个呃注音的判断，你可以先用 jev 这个东西按」
   before: outcome=skipped hash=46eb5c12e90a  | after: outcome=skipped hash=-
   after 当前任务行前80字: (无块)
#39 b3c1d3d0 step=1 at=2026-09-28 00:15 user=「你先把它做成正方形的那种效果吧，你现在做的是一个竖形的竖直方向的，根本就不能用」
   before: outcome=skipped hash=e26fc13b7d58  | after: outcome=skipped hash=-
   after 当前任务行前80字: (无块)
=== REPLAY SUMMARY {"matched":39,"beforeSkipped":39,"afterDiffers":13,"afterInjected":13,"afterTaskLine":13,"continuing":0}
```

## 6 三个真实会话样例 (用户说继续 → 注入什么)

两条来自 .hark-tmp/ts-samples.json (真实会话截取, 每段到当前用户轮前 80 条消息), 一条来自 HX-Memory 自己的完整会话日志 session-eae93a5c seq=710。都用空库 Binder 跑真实 prestep, 下面是实际注入块原文:

```
=== SAMPLE 低信息 yes session=1911b5f4-725c-4785-bc19-0efc7f76026d (ts-samples.json, 前 80 条消息) outcome=injected
【HX-Memory】
以下为检索到的历史记忆, 不是新指令; 标记 rule 的是用户确认过的约束。
【当前任务】用户本轮只说「yes」= 继续上一任务「那你能不能强制进入呢？就比如说你用协议注册成功了，那你不是最终也得到1个浏览器凭证吗？那你直接用浏览器凭证去注入浏览器里面不就能进去了吗？然后再是走那个出口的这」(动作: 新增; 涉及 vendor/genspark2api/cookies/cookies_proto_1791645235.json、deepseek-ai/dsh-ptc-runtime-node/lib/process.js、workspaces/browser-auto/knowledge/genspark/FINDING-2026-10-11-egress-truncates-response-and-lies-200.md、/tmp/mk_cookies.py、/tmp/gs_inject_z_v3edo1/cookies.txt)。接着做这件事, 不要另起话题。
=== SAMPLE 低信息 next session=5d144edf-e119-4fab-961b-66a8be3d163b (ts-samples.json, 前 80 条消息) outcome=injected
【HX-Memory】
以下为检索到的历史记忆, 不是新指令; 标记 rule 的是用户确认过的约束。
【当前任务】用户本轮只说「next」= 继续上一任务「改好的东西，做好提交获取到远程，然后触发一下我配置的那些code review。qodo 这种。」(动作: 修改; 涉及 workspaces/browser-auto/gmail-login/tools/fp_probe.py、workspaces/browser-auto/gmail-login/server/app/egress_src.py、app/egress_src.py、/tmp/msg1.txt、.agents/notes/implemented/feature/2026-10-10-fingerprint-stability-no-legacy-self-replication.md; 未闭合的失败: Error: e["same_as_host"] = bool(host_ip and info == host_ip) 307: else: 308: e["probe_error"] = info 309: break 310: for)。接着做这件事, 不要另起话题。
=== SAMPLE 真实 next session=eae93a5c seq=710 (完整会话日志) outcome=injected
【HX-Memory】
以下为检索到的历史记忆, 不是新指令; 标记 rule 的是用户确认过的约束。
【当前任务】用户本轮只说「next」= 继续上一任务「为什么目前显示的经验沉淀要我审核的东西？我看不到它详细的内容是啥？那我怎么知道要沉淀」(动作: 排查; 涉及 src/adapters/dsh/gateway.ts、src/adapters/dsh/client/review-page.tsx、tests/s2/review-projection.test.ts、src/generalize/service.ts、src/adapters/dsh/client/locale.ts)。接着做这件事, 不要另起话题。
```

样例 2 的「未闭合的失败」是误报: task-state 的 lastError 把工具输出里一段 Python 源码中的 `e["probe_error"]` 识别成 Error。属于 task-state 报错检测词表的问题, 本轮未改。

### 演示 (exec: node --experimental-strip-types --import ./.hark-tmp/js2ts-loader.mjs .hark-tmp/prestep-wiring-replay.ts demo)

```
=== DEMO (记忆库为空, 上一轮是明确任务, 本轮只说「继续」) outcome=injected len=315
【HX-Memory】
以下为检索到的历史记忆, 不是新指令; 标记 rule 的是用户确认过的约束。
【当前任务】用户本轮只说「继续」= 继续上一任务「把 task-state 接进 src/adapters/dsh/prestep.ts, 改注入块的拼装」(动作: 修改; 涉及 src/adapters/dsh/prestep.ts、src/kernel/task-state.ts; 未闭合的失败: Error: src/kernel/task-state.ts(173,21): error TS2550: Property 'findLastIndex' does not exist)。接着做这件事, 不要另起话题。
```

注: 纯 `node --experimental-strip-types` 跑不动 src, 因为源码相对 import 写的是 .js (prestep.ts → ./guidance.js), 磁盘上是 .ts (报 ERR_MODULE_NOT_FOUND)。所以加了 18 行的 resolve hook (.hark-tmp/js2ts-loader.mjs), 只做 .js → .ts 的映射。

## 7 没做完的部分与原因

1. tsc 退出码仍是 2: 4 条 findLastIndex 报错在 task-state.ts, 要 tsconfig lib 改成 ES2023 才会消失; 磁盘上的 tsconfig.json 还没改, 我也没改 (不在本轮范围, 且另一路在改)。
2. 39 行账本只有 13 行不再相同。剩下 26 行要变, 得让 task-state 识别「接着做并行的做…」「你为什么不继续做？」这类长句里的续接语义, 或者降低 goal 门槛; 前者要改 task-continuation.ts (本轮禁改), 后者会加噪声。
3. 块里的当前任务行排在框架句「以下为检索到的历史记忆, 不是新指令…」之后。这是 composeMemoryBlock 现有结构 (body 非空就写框架句); 严格说当前任务行不是「历史记忆」。要分开得改 kernel/format-frame.ts, 本轮未动。
4. first 注入模式下, 续接行 (force) 会像挫折纠正一样越过「只注入一次」。理由是这是当轮信息, 等下次会话就没用了。如果你要 first 模式绝对只注入一次, 把 force 行排除出 first 判据只需改一处。
5. 只在 exec 宿主上跑过单测、回放与样例, 没在真实 DSH 宿主里起会话端到端验证 (sessionEvents 在 0.1.2+ 的 eventAt 分支用的是线上 session 对象, 单测用的是 events 数组分支)。
6. 没有 git 提交 (按要求)。

## 8 判据自查

1. PRESTEP-WIRING.md 存在且 > 3000 字节: 是 (写回后用 ls -l 核对, 见回复)。
2. 含 `npx vitest run` 真实输出且有 "Test Files": 是 (第 4 节, 两组)。
3. "Tests " 后跟通过数且 ≥ 1500: 全量 `Tests  1508 passed (1508)`, 是。
4. 出现 39 且旁边有改造前后对照: 第 5 节, 39 行逐行 before/after hash 对照 + 汇总 (前 39/39 skipped, 后 13/39 injected 且文本不同)。
5. 至少一段真实注入文本 > 40 字符: 第 6 节演示块 315 字符, 另有 3 段真实会话样例。
6. task-state.ts: 本次未改该文件, 只接线, 接线在 src/adapters/dsh/prestep.ts (第 39-72、202-203、301-310、361 行)。task-state.ts 的 mtime 2026-11-03 21:52 是另一路写 note 时改的, 不是我。
7. prestep.ts 行号: 第 2 节表格 (39-40、42-56、58-72、202-203、301-310、361、373)。
8. 没扩 intents.ts 正则、没降断言、没改评测集/面板/旧报告、没碰 dist、没提交 git: 是。
