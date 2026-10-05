// src/adapters/dsh/settings.ts — HX-Memory 的设置 schema (schemastery)。
//
// ## 为什么每个字段都要 `.volatile()` (2026-09-29, 宿主 0.1.7 适配)
//
// 0.1.7 把设置系统整体换掉了: 旧的 `ctx.settings.installSection(owner, ns, schema, ...)`
// / `register(ns, schema)` **两个入口都已从 SettingsForms 类里删除** —— 插件侧那两条
// 调用路径在新宿主上什么都不做, 而**不会有任何报错**。新宿主改为**自动投影**: 它从
// `entry.fiber.runtime.Config` (= 本模块导出的 `Config`) 读 schema, 再走
//
//     describe() → volatileForm(schema) → 只保留 meta.volatile 的字段
//
// 两条判据缺一条, 该条目就被**静默跳过** (`return []`), 面板上表现为"这个插件没有设置":
//
//   1. 插件必须 `export const Config` (见 index.ts) —— 否则 `entry.fiber.runtime.Config`
//      是 undefined, `schema(entry)` 直接返回 undefined;
//   2. 字段必须 `.volatile()` —— 否则 `volatileForm()` 递归完发现一个都没标, 返回 undefined。
//
// 而 `.volatile()` 需要 schemastery >= 3.18.4 (3.18.2 上根本没有这个方法 —— 实测
// `typeof schema.volatile === "undefined"`)。这也是 package.json 把 schemastery 从
// `^3.18.2` 抬到 `^3.18.4` 的唯一原因。
//
// 附带收益: volatile 字段在 loader 里是**引用对象** (`{get()}`), 设置改动由宿主
// `_commitVolatile()` 原地写进引用 —— 不需要重启, 也不需要 installSection 那套
// "接住权威 thunk" 的约定 (那条约定在新宿主下已无处可接)。
import z from "@deepseek-ai/schemastery";
import type Schema from "@deepseek-ai/schemastery";
import { DEFAULT_STRUCTURER_PROMPT, DEFAULT_ABSTRACTOR_PROMPT } from "../../prompts.ts";

/** 设置命名空间。新宿主下它就是 **runtime 条目的 entry id** (见 dsh/cordis.patch.yml)。 */
export const MEMORY_SETTINGS_NAMESPACE = "hx-memory";

/**
 * 所有设置字段都标 volatile: 它们是"面板可改、改完立刻生效"的字段。
 *
 * 两个提示词字段额外 `.hidden()` —— 它们是内部实现细节 (抽取/抽象用的提示词),
 * 不该占满「设置 → 插件」页; 但它们必须留在 schema 里, 因为配置文件里已有值要能往返。
 *
 * 显式标注 `: Schema` 是**可移植性防线**, 不是装饰: 推导出来的类型会就地展开成一长串
 * schemastery 内部泛型 (`.pnpm/@deepseek-ai+schemastery@<版本>/...`)。依赖树里一旦出现
 * 第二份 schemastery, 声明生成就会因"类型无法在不引用那条私路径的情况下命名"而失败
 * (TS2742) —— 本轮实测撞到过 (旧 peer 把 3.18.2 拖回来时)。绑到公开的 `Schema` 具名类型后,
 * 声明文件与"最终解析到哪一份"解耦。
 */
export const Config: Schema = z.object({
  autoCapture: z.boolean().default(true).volatile(),
  autoMemoryInterval: z.natural().min(0).max(1000).default(1).volatile(),
  rootAgentsOnly: z.boolean().default(true).volatile(),
  language: z.union(["zh", "en"]).default("zh").volatile(),
  injectGuidance: z.boolean().default(true).volatile(),
  injectBindings: z.boolean().default(true).volatile(),
  // 注入时机: first = 只在会话首轮注入一次 (常驻记忆本来就不变); every-turn = 逐轮差量补新。
  // 为什么是枚举而不是布尔: 它与"注入哪些内容"正交, 将来要加 "on-demand" 时不必再加开关。
  injectMode: z.union(["first", "every-turn"]).default("every-turn").volatile(),
  autoEvolve: z.boolean().default(true).volatile(),
  semanticWarmupMs: z.natural().min(0).max(2000).default(50).volatile(),
  // 决策层 (召回闸): 判"这一轮该不该注入记忆"。
  // ⚠ 默认**关**: 地基已就绪(端口+两层回退+账本), 但把判官接进每轮注入会引入一次
  // ~0.5s 同步开销 —— 那是需要用户拍板的取舍, 不该由默认值替他决定。
  decisionGate: z.boolean().default(false).volatile(),
  /** 决策账本保留天数 (0 = 永久)。 */
  decisionRetentionDays: z.natural().min(0).max(365).default(7).volatile(),
  // 保底通道的**条数上限** (2026-09-29): token 闸管长度, 条数闸管注意力成本。
  // 默认 3: 真实首轮注入 9 条/581 token, 其中 41% 是包装 —— 用户实测"太多无用上下文"。
  // 0 = 不限制 (恢复旧行为, 便于对照实验)。
  alwaysOnMaxEntries: z.natural().min(0).max(50).default(3).volatile(),
  captureEpisodes: z.boolean().default(true).volatile(),
  episodeRetentionDays: z.natural().min(0).max(36500).default(90).volatile(),
  // 注入调度账本: 落盘"为什么注入/为什么没注入", 与捕获开关解耦 (两者是不同的东西)。
  scheduleLog: z.boolean().default(true).volatile(),
  scheduleLogRetentionDays: z.natural().min(0).max(3650).default(14).volatile(),
  // 捕获耗时账本: 落盘"这一轮沉淀花了多久、花在哪一段、为什么没沉淀"。
  // 与 scheduleLog 是两条不同的轴 (判定 vs 耗时), 因此是两个开关。
  captureLog: z.boolean().default(true).volatile(),
  captureRetentionDays: z.natural().min(0).max(3650).default(7).volatile(),
  // 后台维护: 周期 (小时, 0 = 关闭) + 空闲门槛 (分钟)。两者都实时读 —— 面板改动不必重启。
  maintenanceIntervalHours: z.natural().min(0).max(720).default(6).volatile(),
  maintenanceIdleMinutes: z.natural().min(0).max(1440).default(10).volatile(),
  structurerPrompt: z.string().default(DEFAULT_STRUCTURER_PROMPT).hidden().volatile(),
  abstractorPrompt: z.string().default(DEFAULT_ABSTRACTOR_PROMPT).hidden().volatile(),
  // ── 负面/纠正信号 (2026-10-05, 用户要求"直接给个地方让用户配置") ──────────────
  // 词表是**文本**而不是数组: 面板里文本框最直接。两种写法都支持 (见 kernel/negativity.ts
  // 的 parseNegativityWords): 多行 (`类别头` + 一行一条) 或单行 (`类别:词1,词2;类别:词3`)。
  negativityWords: z.string().default("").volatile(),
  negativityGate: z.boolean().default(true).volatile(),
  negativityJudge: z.boolean().default(false).volatile(),
});

export type ConfigSchema = typeof Config;

/**
 * schema 声明的设置字段名 (单一来源: 直接读 `Config.dict`)。
 *
 * 为什么从 schema 派生而不是再手写一份清单: 两份清单必然漂移, 而漂移的表现是
 * "某个设置改了不生效" —— 正是本节开头那类静默故障。派生之后, 字段加进 schema
 * 就自动进入读取路径与集合校验。
 */
export const MEMORY_SETTING_KEYS: readonly string[] = Object.keys(Config.dict ?? {});
