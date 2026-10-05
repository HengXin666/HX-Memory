# Agent Note: peer 范围与 dsh.host 漂移会让整个插件包被静默跳过

Status: implemented

## Problem

HX-Memory 在宿主 dsh 升到 `0.2.0-rc.2` 后**整个插件从进程里消失**: 记忆注入没有、三个 Web 面板没有、`memory_search` 等工具没有。表现与"插件从未安装"完全一致, 而**启动日志里没有一行报错** —— 宿主把这件事降级成了一条 `dsh: skipping profile bundle ...` 的诊断。

实测证据 (2026-09-30, 宿主 `@deepseek-ai/dsh@0.2.0-rc.2`):

```
dsh: skipping profile bundle "@hengxin666/hx-memory": Error: Plugin
@hengxin666/hx-memory@0.1.0 is incompatible with dsh 0.2.0-rc.2:
peerDependencies {"@deepseek-ai/dsh-client-connection":"^0.1.7-rc.2", ...}
... Exact-version exemption: not active.
```

成因是**两份兼容声明漂移**:

1. `package.json` 的 `dsh.host` 已经是 `^0.1.7-rc.2 || ^0.2.0-rc.1` (2026-09-29 适配 0.1.7 设置契约时抬高, 见
   [dsh 0.1.7 宿主适配](2026-09-29-dsh-017-settings-contract.md))。
2. 但 `peerDependencies` 里七个 `@deepseek-ai/dsh-*` 仍停在 `^0.1.7-rc.2`。

宿主的兼容门禁 (`evaluatePluginCompatibility` in `@deepseek-ai/dsh-app-boot`)**只读 `peerDependencies`**, 逐个对 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-*` 做 `semver.satisfies` 判定; `dsh.host` 它**根本不看** (那个字段只被本仓的 `scripts/lib/host-version.mjs` 用来决定 CI 装哪个版本)。于是在 `^0.1.7-rc.2` 的 0.x 语义下, minor 进位被当作 breaking, `0.2.0-rc.2` 不满足范围, 判定为不兼容 → 整包跳过。

危险之处在于**失败是双向错位的**: CI 全绿 (它装的是范围内的 latest), 真机整个插件不加载, 而这句话只在启动时打一次、且措辞是 `skipping` 而不是 `error`。

同一次排查还确认了两个事实, 它们决定了这一版该修"声明"而不是修"代码":

- **0.2.0-rc.2 对这七个包的公开 API 没有任何变更**。逐包比对 `lib/index.js` 的 md5 与字节数 (`dsh-tools` 403a343fc905/157954、`dsh-llm` 4215f4d19f79/103549、`dsh-typert-protocol` a09a54941609/12267 …) **全部逐字节相同**; 三个类型入口的导出符号集 (39/9/17/22) diff 为空, `types/index.d.ts` 的 md5 也相同 (c1515b54648952acfa1868bac924d686)。0.2.0 只是把类型文件从单文件拆成了多文件, 模块身份与运行时行为没动。
- 插件实际使用的五个符号 (`defineTool` / `Remote` / `TypertRemoteService` / `BlockAssembler` / `createUserMessage`) 在新旧宿主里都存在。

## Decision

**`peerDependencies` 的 dsh 包范围与 `dsh.host` 同源同值, 并由断言钉住。**

七个 `@deepseek-ai/dsh-*` 的 peer 范围改为 `^0.1.7-rc.2 || ^0.2.0-rc.1`, 与 `dsh.host` 逐字一致。`@deepseek-ai/cordis` 与 `@deepseek-ai/schemastery` 保持不动 —— 门禁的判据是 `name === "@deepseek-ai/dsh" || name.startsWith("@deepseek-ai/dsh-")`, 这两个不参与。

选"抬高声明"而不是"申请豁免"或"改代码", 因为它们各自对应一个更差的结局 (见下节替代方案)。

`tests/s1/host-version.test.ts` 新增一条机械断言: 遍历 `peerDependencies` 里所有 dsh 包, 要求每个范围**逐字等于** `dsh.host`, 且断言 dsh peer **数量大于零** (否则删光 peer 也算"同源", 会让这条守卫空转通过)。

## Alternatives considered

**用 `dsh plugin allow-version` 批一个 exact-version 豁免 (写进 `compatibility.json`)。** 它能立刻让插件重载, 但**把漂移固化了**: 豁免是 `包@版本` 对 `精确宿主版本` 的授权, 下一次宿主升到 `0.2.0-rc.3` 就再次失效, 而那时出错的位置从"插件声明"变成了"某台机器上 `~/.dsh` 里的一个 JSON 文件" —— 换台机器、换个 profile 就复现不了。它是本机应急手段, 不该是仓库的答案。

**把 peer 直接改成 `^0.2.0-rc.1` (只留新宿主)。** 会丢掉 0.1.7 通路, 而 `dsh.host` 明确声明支持它, 两者反而制造了新的不一致。而且本次七个包的实现逐字节相同, 没有任何理由放弃旧宿主。

**把 peer 写成 `workspace:*` 或更宽的 `>=`。** 门禁对 `workspace:^` / `workspace:~` / `workspace:*` 有特判 (解析为当前运行时, 恒满足), 而其它非法范围按不兼容处理。用 `workspace:*` 等于关掉这道门禁 —— 它此后对任何宿主都放行, 包括真正 breaking 的下一个 major。

**让 CI 在读 peer 的同时也校验 `dsh.host`。** 这正是本次漏掉的那一环, 但它修的是"能发现", 不是"插件能用" —— 真机仍然不加载。所以两件事都做: 范围先对齐 (让插件回来), 断言再补上 (让下次漂移在单测里就红)。

**假设 0.2.0 有破坏性变更, 因此去改插件代码。** 证据否掉了它: 七个包的 `lib/index.js` md5 全同、导出面 diff 为空、插件用到的五个符号两端都在。在没有任何行为差异的前提下改代码, 只会引入真实回归。

## Consequences

换来的: 插件在 `0.1.7-rc.2` 与 `0.2.0-rc.2` 上都能加载 (两条通路都是"声明支持且实测可用", 不再是"声明支持但静默跳过"); 下次 `dsh.host` 抬高而 peer 忘了跟, 单测直接红, 而不是等用户在面板上发现插件没了。

付出的: 每次抬高 `dsh.host` 都要同时改八处范围 (一个 host + 七个 peer)。这条成本由断言代偿 —— 漏改是**不可能的**, 只会在测试里报错。代价是范围收窄仍是人工判断: 当上游发布真正 breaking 的版本时, 这条断言**不会**告诉你"能不能加进去", 它只保证"加就一起加"。

**连带修复 (本机 profile, 不在本仓库)**: 排查时发现 `~/.dsh/profiles/web/cordis.patch.yml` 里的 `mcp-aegisub` 条目写法是错的 —— 它被写成**顶层裸条目** `- id: mcp-aegisub`, 而 patch 的语义是"按 id **覆盖**已有条目", 组合树里没有这个 id, 于是宿主只打一行 `patch: entry "mcp-aegisub" not found` 就跳过, Aegisub MCP **从未加载过**。正确写法是包在无 id 的 `insert:` 里 (表示"往顶层追加新条目")。已修正并实测该条目出现在组合树中。

## Testing

- `tests/s1/host-version.test.ts` (11 条): 新增的 peer/host 同源断言做过变异验证 —— 把 `@deepseek-ai/dsh-tools` 的 peer 改回 `^0.1.7-rc.2` 后该条**变红** (1 failed | 10 passed), 恢复后回到 11 passed。这证明它不是一条恒真断言。
- 真机判据: `dsh --profile web --dump-config` 从"打印 `skipping profile bundle "@hengxin666/hx-memory"` 且树里没有该条目"变为"树里出现 `hx-memory-group` / `hx-memory` / `hx-memory-client` 三条, 且再无 skipping 行"。
- `pnpm exec tsc --noEmit` 通过; `scripts/verify-agent-note-coverage.ts` 通过。
