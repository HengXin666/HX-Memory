# Agent Note: dsh 0.1.7 宿主适配 — 设置系统的三处硬变更

Status: implemented

## Problem

HX-Memory 在宿主 dsh `0.1.7-rc.2` 上"看着正常、实际半死": RPC 端点全通、注入通道照常往上下文塞记忆、三个 Web 面板都在槽位上 active, 但**设置在界面上整块消失** —— 「设置 → 插件」里找不到 hx-memory 命名空间, 那张「记忆注入」卡也永远等不到数据。全链路**零报错**。

宿主在这一版把设置系统整体重写了, 插件的接入点被删掉, 而删除是静默的:

1. **旧入口已不存在。** `SettingsForms` 类上 `installSection` 与 `register` **两个方法都没有了** (实测该版本的 `lib/index.js` 里 `installSection` 命中数为 0)。插件侧那两条调用路径在新宿主上什么都不做, 且不会报错 —— 只有 `typeof service.installSection === "function"` 的判空分支默默走到"两个都没有"的告警分支。
2. **改为自动投影, 且只收 volatile 字段。** 新宿主从 `entry.fiber.runtime.Config` 取 schema, 再经 `describe() → volatileForm()` 过滤, **只保留 `meta.volatile` 为真的字段**。一个都没有时 `volatileForm()` 返回 `undefined`, 该条目被 `return []` 直接跳过。两条判据 (导出 `Config` + 字段标 `.volatile()`) 本仓都不满足: 运行时入口没导出 `Config`, 且依赖锁在 schemastery `3.18.2` —— **那个版本上 `.volatile()` 根本不存在** (`typeof schema.volatile === "undefined"`)。
3. **设置命名空间从"插件注册的名字"变成 entry id。** `describe()` 产出的 `ns` 就是 `entry.options.id`, `update(ns, …)` 也是拿 ns 去 `entries().find(row => row.options.id === ns)`。于是 `settings.ts` 里的 `MEMORY_SETTINGS_NAMESPACE = "hx-memory"` 不再决定任何事 —— 真正生效的是 profile patch 里的条目 id, 而它当时叫 `hx-memory-runtime`。

同一次排查还发现本机 profile patch 里已有一条**被宿主静默跳过**的补丁: `hmr` 那条写的还是改名前的包名 `@deepseek-ai/cordis-plugin-hmr`, 宿主上报 `patch: name mismatch for "hmr" (expected "@deepseek-ai/dsh-hmr", got "@deepseek-ai/cordis-plugin-hmr"), skipping` —— 意思是这个仓库的 HMR 热重载其实一直没生效。

## Decision

**插件的设置面按新契约接, 同时保留三代宿主的回退路径。**

设置 schema 的每个字段都标 `.volatile()` (`src/adapters/dsh/settings.ts`)。这既让新宿主的 `volatileForm()` 认它, 也让设置具备"改完当轮生效"的语义 —— volatile 字段在 loader 侧被解析成**引用对象** `{ get() }`, 面板改动由宿主的 `_commitVolatile()` 原地写进引用, 不重启、不 dispose。

`Config` 由**运行时入口自己**再导出一次 (`export { Config } from "./settings.js"`) —— 宿主取的 `entry.fiber.runtime.Config` 就是 `cordis` 的 `plugin()` 处读到的 `plugin.Config`, 而那正是这个模块的导出面。少这一行, 宿主判定"该条目没有 schema"。两个提示词字段额外 `.hidden()` (内部实现细节, 不该占满设置页, 但要留在 schema 里让配置文件里的值能往返)。

schema 的字段名从 `Config.dict` **派生** (`MEMORY_SETTING_KEYS`), 不再手写第二份清单 —— 两份清单必然漂移, 而漂移的表现正是本节开头那类静默故障。

读取路径按**能力**而不是版本号分流 (`src/adapters/dsh/settings-live.ts`): 先看宿主给进来的 config 里有没有 `{ get }` 形态的引用; 所有 schema 字段都是引用才接管, 少一个就整体交回旧路径 —— 半接管会得到"部分设置跟面板、部分跟默认值"的状态, 在界面上表现为"某个开关怎么改都没用", 极难排查。三步的顺序 (算组合配置 → 接引用 → 交出去用) 收在一个 `createLiveSettings()` 里由结构保证, 因为顺序写错的症状同样是静默的。

设置命名空间靠**改 profile patch 的条目 id** 对齐: 组条目改成 `hx-memory-group`, 让 runtime 条目占用 `hx-memory`。两条 id 必须各自唯一 —— `configEditor.entries()` 会丢掉出现次数 ≠ 1 的 id (两条同名 → 两条一起消失)。改回 `hx-memory` 还顺手修好了旧事: 此前 `settings.yaml` 里的 `hx-memory:` 段迁移时因"找不到该 id 的条目"被留在 `.imported` 文件里没导进来, 用户之前存的 `injectMode: first` 因此一直没生效。

客户端那张卡同时注册**两个槽位**: 0.1.7 的 `plugins.bundle.config` (key = 包名) 与旧宿主的 `settings.plugin.item` (key = 命名空间)。取作用域也按能力探测 —— 新宿主是 `configForms.get(entryId)`, 旧宿主是 `settingsScope.bind({ namespace })`; 两者返回面在卡片用到的四个方法上**同形**, 所以组件一行不用改。注册**无条件**进行, scope 解析推迟到宿主真正渲染卡片时 (inject 钩子): 客户端插件之间没有声明依赖, apply 与承载服务的插件完全可能交错, 在 apply 时就要求 scope 存在会让卡片**永远**消失且无报错。

`settings` 服务上显式调 `configure({ auto: true })`。`auto: false` 的语义是"本插件自带设置页, 别生成", 而自带页依赖的旧槽位在新宿主已不存在 —— 配上去会得到一个"命名空间注册着、21 个字段一个都看不见"的空页面。

版本声明与依赖一起抬高: `dsh.host` 改为 `^0.1.7-rc.2 || ^0.2.0-rc.1`, schemastery 提到 `^3.18.4` (`.volatile()` 的唯一来源)。本机 profile patch 里 `hmr` 的包名改成 `@deepseek-ai/dsh-hmr`。

> [!NOTE] 更正 (2026-09-30): 本条改动**当时只抬高了 `dsh.host`, 七个 `@deepseek-ai/dsh-*` 的 `peerDependencies` 并没有跟着抬** (仍停在 `^0.1.7-rc.2`)。原文写作"九个 peer 包对齐宿主同版本", 与落地不符。宿主装载 bundle 前的兼容门禁只读 peer 而不读 `dsh.host`, 于是这一漂移在 0.2.0-rc.2 上表现为**整包被静默跳过**。已在同一轮补齐并加断言钉住, 见
> [peer 范围与 dsh.host 漂移会让整个插件包被静默跳过](2026-09-30-peer-range-drift-silently-skips-bundle.md)。

## Alternatives considered

**只在插件里补 `installSection` 的等价实现。** 输在新宿主上没有任何可注册的入口 —— 类上连方法都没有, 补调用只会命中判空分支。设置的真源在 `entry.options.id` 与 `entry.fiber.runtime.Config`, 这两样都不由插件"注册"决定。

**手写第二份设置字段清单给读取路径用。** 输在漂移: schema 加字段而清单没跟, 表现是"新开关改了不生效", 又一次静默故障。从 `Config.dict` 派生让两者物理上不可能不一致。

**用宿主版本号 `if (semver.gte(host, "0.1.7"))` 分支。** 输在脆弱: 版本字符串与能力之间没有强制关系, 而这次踩的正是"名字换了、版本号和功能都对不上"的坑。按能力探测让判据与真实行为一致, 也让单测能用最小桩覆盖两代。

**把 `auto` 留成省略 (吃默认 true)。** 输在"默认值会漂": 现在的默认恰好是 true, 但把语义写出来才能承载这个决定本身 —— 这里 `false` 的代价是**整页空白**, 值得显式钉住并写下理由。

**在不带 `.volatile()` 的前提下让字段进表单。** 做不到: `volatileForm()` 是唯一入口, 它按 `meta.volatile` 递归过滤, 一个都没标就返回 `undefined`, 条目被跳过。`volatile` 也顺带承载了"改完当轮生效"的语义 —— 读路径要的正是这个。

**把 runtime 条目统一改名成 `hx-memory-runtime` 并同步改 `MEMORY_SETTINGS_NAMESPACE` 与旧配置文件。** 输在成本与兼容: 改常量是一行, 但用户已存的 `settings.yaml` / 迁移残留里写的是 `hx-memory`, 改名等于让那份配置永远对不上; 而 `hx-memory` 本来就该是这个插件的条目名。

## Consequences

设置面恢复: 冒烟断言从"settings 命名空间未注册"转为全绿, `settings/describe` 实测返回 `ns: "hx-memory"` 且 `autoGenerate: true`, `injectMode` 默认 `every-turn` 可读可写真往返。

代价是适配层多了一层: `settings-live.ts` (volatile 引用接管 + 三步顺序) 与 `plugin-options.ts` (入口选项与默认路径) 从组装根分出, `settings-wiring.ts` 变成三代宿主的分流点。组装根因此回到 385 行 (门禁上限 400)。

**负向保证**: 找不到 volatile 引用时**不**接管设置源, 而是把控制权交回 `installSection`/`register` 回退路径 —— 旧宿主 (0.1.1 有 `register`、0.1.2~0.1.6 有 `installSection`) 的行为一字未改。回归由 `tests/s2/settings-adoption.test.ts` 的 10 条钉住, 其中一条真实抓到了本轮的一处回归: 回退路径收到裸 `opts.settings` 会让宿主侧大部分字段变成 `undefined`, 修法是交出**补全过默认值**的组合层 (`LiveSettings.composition`)。

**为什么删除是静默的, 因此为什么必须有真机断言**: 三处变更没有一个会在日志里说话 —— 旧入口不存在只是判空为假, 字段没标 volatile 只是 `describe()` 少一行, entry id 不对只是 `ns` 不匹配。宿主自己那条 `settings: section … was not imported into entry …` 的 warn 是唯一线索。所以 `scripts/smoke-dsh.sh` 里关于设置命名空间的断言 (对真机 `settings/describe` 取 ns) 是这类缺陷的**唯一**防线, 新增适配层时不要把读取路径绕开它。

**明确放弃的**: 不追求在 0.1.1/0.1.2 上新增能力, 只保证它们不回归; 不为客户端卡片做 0.1.7 的 `plugins.item` 官方插件页 (那需要注册成"官方插件", 与"配置位于 bundle 页"的定位不符)。

**HMR 的连带修复**: 包名那条补丁此前被宿主跳过, 修正后 HMR 才真正生效 (配置里的 `disabled: false` 与 `root: [dist]` 不再被忽略)。

## Testing

`scripts/smoke-dsh.sh` 是真机门禁 (隔离 `DSH_HOME` → 装包 → 起 web host → 打 HTTP 断言), 本轮把两条断言从旧契约改成新契约: profile 组合里断言组条目 `hx-memory-group` 与 runtime 条目 `hx-memory` 各自存在, fiber 断言按 `entryId` 精确匹配。它现在覆盖 `设置命名空间已注册 (Typert settings/describe)` 与 `注入时机开关可读可写`。

`tests/s2/client-injection-card.test.ts` 钉客户端两条注册 (新旧槽位各一)、按能力探测作用域 (configForms 优先于 settingsScope)、以及"服务迟到也必须在渲染时被认到"。

`tests/s1/host-version.test.ts` 的假 npm 表随 `dsh.host` 新范围更新; `tests/s3/maintenance-replay.test.ts` 的设置断言改为读 volatile 引用的 `.get()` (字段是 volatile 后解析结果不再是裸值)。

`tests/s2/client-review-render.test.ts` 一处数量断言改成集合判定 —— 与文件里既有的原则一致: 加一条卡片接线不该让"三个面板都接上了"这条断言假红。
