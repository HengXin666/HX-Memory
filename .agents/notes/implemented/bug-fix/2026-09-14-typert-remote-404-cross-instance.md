# Agent Note: 远程端点整组 404 — 跨实例的 Typert marker

Status: implemented

## Problem

DSH 面板的每一个 `hxMemory/*` 端点都返回 `HTTP 404`, 而插件看起来完全正常:
fiber `runtime` 与 `client` 都是 `active`、profile 组合成功、日志里没有一条错误。
面板上唯一的表现是状态条那行 "状态读取失败: transport failure ... HTTP 404"。

这不是某个方法名写错。带合法会话 cookie 逐个探测, **19 个端点一起 404**;
同一时刻同一通道上的宿主端点 (`pluginInventory/list`) 返回 200。
"整个 namespace 都不存在"与"某个拼写错了"是两种完全不同的故障, 前者指向发现环节。

根因在 `@Remote` 标记的**存储介质**, 而它是随协议版本变过的:

| protocol 版本     | marker 存在哪                                   | 跨模块实例可见 |
| ----------------- | ----------------------------------------------- | -------------- |
| `0.1.1-rc.2`      | 模块私有 `WeakMap` (`markers.get(prototype)`)  | 否             |
| `>= 0.1.2-rc.1`   | 原型上的字符串键属性 `"…/remote-methods"`        | 是             |

宿主 (`dsh-api-gateway`) 用的是**它自己那份** protocol 去读标记的: 它遍历 `ctx.reflect.props`,
拿 `receiver.typertRemote`, 再调自己那份的 `remoteMethods(original)`。
当插件从自己的 `node_modules` 加载了 `0.1.1-rc.2`、而宿主是 `0.1.5-rc.1` 时,
两份实例各有一个 WeakMap, 宿主读到的永远是 `[]` → `claimsEndpoint` 为假 → 404。

实测 (同一台机, 决定性):

- `pluginCopy.remoteMethods(gateway)` → **19** 条 (插件自己看得见自己写的);
- `hostCopy.remoteMethods(gateway)` → **0** 条 (宿主什么也看不见)。

时间线也吻合: 9/13 该面板还是好的 (宿主当时是 `0.1.1-rc.2`, 两份实例同为 WeakMap 形态 ——
WeakMap 是模块私有的, 但**同一份模块文件**被两边加载时是同一个 WeakMap, 所以能用);
9/14 宿主换成 `dsh@0.1.5-rc.1` 之后立刻全量 404。

两个"为什么没有被更早发现"的原因, 都值得单独记:

1. **门禁跑的是另一个版本。** `boot-smoke.yml` 装的是 `dsh@0.1.2-rc.1`, 而坏掉的是 0.1.5-rc.1 的宿主。
2. **单测结构性地绕过了这一环。** `tests/s3/gateway.test.ts` 直接调方法; `tests/s2/remote-methods.test.ts`
   只比对源码里的方法名字面量。两者都碰不到"宿主用哪份模块来发现标记"。

## Decision

**一、把协议对齐宿主的实际版本。** `package.json` 里 `@deepseek-ai/dsh-typert-protocol` 从
`0.1.1-rc.2` (peer `^0.1.1-rc.2`) 提到 `0.1.5-rc.1` (peer `^0.1.5-rc.1`)。
选 `0.1.5-rc.1` 而不是最低可用的 `0.1.2-rc.1`, 理由是它同时是 npm `latest`、是 `dsh` 自身的
`latest`、也是本机宿主的版本 —— 对齐"宿主会装的那一个"比贴着下界更有价值。
`^0.1.5-rc.1` 仍然接受 `0.1.5-rc.2`, 但没有接受 `0.1.6`/更高: 据实测只有 0.1.2-rc.1+
才有跨实例可读的 marker, npm 上不存在会违反 marker 机制的后继版本, 所以这个上界是**保守**而不是必需。

**二、把"宿主能不能发现端点"变成一道装期校验。**

- 新增 `src/adapters/dsh/remote-contract.ts`: 用**字面量键** `REMOTE_METHOD_DESCRIPTOR_KEY`
  读原型上的标记表 (`remoteMethodDescriptor` / `remoteMethodNames` / `remoteContract`),
  再用 `assertRemoteContract` 比对"声明的方法名"与"宿主可见的方法名"。
  这个模块刻意**不 import 任何 `@deepseek-ai` 包** —— 判定结果不依赖"本模块加载了哪一份协议",
  任何一份依赖都改不动它。
- `src/adapters/dsh/index.ts` 在装配 gateway 之后立刻校验, 不一致就抛错。

**三、把这条契约钉在测试里。** `tests/s2/remote-contract.test.ts` 同时覆盖:
字面量键读得到 `version/methods`、旧形态 (无标记 / 版本不是 1) 读成空集合而不抛错、
不一致时门禁抛错并点名缺了哪些方法、**真实 `HxMemoryGateway` 实例的标记集合 == `HXMEM_REMOTE_METHODS`**,
以及"装配根真的调用了这道校验"(文本守卫, 防止接线漏掉)。

**四、冒烟脚本自己带 pnpm。** `scripts/smoke-dsh.sh` 之前依赖 `dsh plugin` 能在 PATH 上找到 pnpm,
本机 PATH 上没有 (pnpm 只在 pnpm 自己的目录里), 于是它静默失败在第一行 (`dsh plugin add failed`)。
现在它显式把 pnpm 目录前置到 PATH, 只影响本脚本的子进程。

## Alternatives considered

**只改版本号, 不加校验。** 最省事, 但它把"插件与宿主是否同源"这件事继续留给运气:
宿主再升级一次、或某个间接依赖再带进来一份旧 protocol, 同样的静默 404 会原样复发。
版本号是**当前**的正确取值, 不是防复发的机制。

**catch 住 404 再报错 (在客户端/面板侧)。** 面板已经显示了这行错误, 这正是问题:
错误出现在"最后一个能看见它的地方", 而且用一句 transport failure 盖住了 19 个端点的事实。
在装配期失败能把故障从"面板某一行红字"提前到"插件组装载不了", 可观测性差一个量级。

**在 gateway 里手动 `Object.defineProperty` 写一份标记。** 能让当前宿主看见, 但那是**绕过**协议去
模拟协议的内部格式: 协议下一次改格式 (它已经改过一次) 就会静默失效, 而且把"版本不对"这个真实
问题藏起来。宁可让版本对齐失败得响亮。

**把 peerDependencies 收到 `^0.1.5-rc.1` 之外更窄 (如精确版本)。** 精确版本会让补丁版升级
(0.1.5-rc.2) 也报 unmet peer, 而实测它对 marker 机制无影响; caret 已经排除了会破坏机制的旧版本。

**删掉 `tests/s2/remote-methods.test.ts` 的源码文本比对, 换成只测运行时。** 两者测的是不同东西:
文本比对管"服务端与客户端的名字同源", 新测试管"宿主能否发现"。都保留。

## Consequences

- 换来的: 端点回来了 (真机冒烟 19 项断言全绿, 含 `generalizationStatus`); 并且"宿主读不到端点"
  从**静默 404** 变成**装期抛错** —— 同一个缺陷下次会以插件加载失败的形式出现, 一眼可见。
- 付出的: 插件对 DSH 宿主的版本下限从 0.1.1 一路抬到 0.1.7 (当前 `dsh.host` 是
  `^0.1.7-rc.2 || ^0.2.0-rc.1`, peer 同步) —— 2026-09-29 为适配 0.1.7 的设置契约继续抬高,
  见 [dsh 0.1.7 宿主适配](2026-09-29-dsh-017-settings-contract.md)。0.1.1~0.1.6 的宿主
  从此是"不受支持"的组合 —— 这次取舍是刻意的: 让"受支持的组合"与"真机门禁跑的组合"
  是同一个集合, 而不是像之前那样门禁跑 0.1.2、线上跑 0.1.5。
  (代码里仍保留 `installSection`/`register` 两条回退路径, 但那只由宿主桩单测覆盖, 不在
  受支持声明内。)
- 付出的: `pnpm-lock.yaml` 因为这份 devDependency 参与了 peer 解析而产生较大 diff;
  已验证它是**版本级**的等价 (对比改前改后锁文件的包版本 token 集合, 只多出当时新增的那一项协议包版本)。
- 仍然存在的风险: 装配期校验只能看见**本实例的**标记表。若宿主将来改用"从别处读取端点清单"
  的机制 (不再读 Service 原型), 这道校验不会发现。届时的征兆同样是 404, 因此排查入口保持在本 Note。
- 未覆盖的部分: `boot-smoke.yml` 硬编码宿主版本的遗留**已在同日的**
  [门禁装载的宿主版本与 package.json 同源](../../process/2026-09-14-host-version-gate-single-source.md)
  里修掉 —— 它现在由 `scripts/lib/host-version.mjs` 从 `dsh.host` 解析。

## Verification

- `scripts/smoke-dsh.sh` (隔离 DSH_HOME + 真机宿主): 19 项断言通过, 含 `generalizationStatus`。
  这条是本次故障的端到端证据 (修复前它会走到 `404` 分支)。
- `tests/s2/remote-contract.test.ts`: 10 条, 含"真实 gateway 的标记集合 == 声明表"。
- 负向对照 (证明这道校验不是恒真): 用 `0.1.1-rc.2` 的 `@Remote` 构造同类实例,
  `remoteContract(...)` 读到 **0** 条, `assertRemoteContract` 抛错。

## 附带修掉的: 门禁装的宿主版本与线上不是同一个

`boot-smoke.yml` 曾写死 `npm install -g @deepseek-ai/dsh@0.1.2-rc.1`, 而线上跑的是 0.1.5-rc.1 ——
**门禁测的版本与出问题的版本不是同一个, 这是本缺陷能活下来的直接原因。** 现在宿主版本只有一个
来源 (`package.json` 的 `dsh.host`), 由 `scripts/lib/host-version.mjs` 解析成 `latest` 并断言
它落在范围内。决策与取舍见
[门禁装载的宿主版本与 package.json 同源](../process/2026-09-14-host-version-gate-single-source.md)。
