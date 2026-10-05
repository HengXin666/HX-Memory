// src/adapters/dsh/settings-live.ts — 新宿主 (dsh >= 0.1.7) 的 volatile 设置引用适配。
//
// ## 为什么需要这一层 (2026-09-29 实测)
//
// 0.1.7 删掉了 `ctx.settings.installSection/register` 两个入口 (SettingsForms 上已无这两个
// 方法)。取而代之的机制是: schema 里标了 `.volatile()` 的字段, 在 loader 侧被解析成
// **引用对象** (`{ get() }`), 随插件 config 一起传给 `apply(ctx, config)`;
// 用户在面板改设置时, loader 走 `_commitVolatile()` **原地更新那个引用** ——
// 不重启、不 dispose、也不经过任何"接住宿主 thunk"的约定。
//
// 因此读取路径在新宿主下变成"读引用": 只要持有引用, 拿到的永远是当前值。本层把这件事
// 收敛成一个 `settingsSource.adopt(() => ...)`, 于是组装根与其余读取点一行都不用改。
//
// ## 为什么必须先探测再接管 (而不是无条件接管)
//
// 单测与旧宿主传给 `apply` 的是一个**普通对象** (没有 `{ get }` 形态的字段)。
// 无条件接管会让那些场景读到一片 undefined —— 而且不会有任何报错, 只是设置"全变默认值"。
// 判据必须是**至少找到一个引用**: 一个都没有时返回 false, 交回 installSection 回退路径。

import type { HxMemorySettings } from "./types.js";
import { DEFAULT_SETTINGS } from "./types.js";
import type { SettingsSource } from "./settings-source.js";
import { createSettingsSource } from "./settings-source.js";
import { MEMORY_SETTING_KEYS } from "./settings.js";

/** volatile 字段在 loader 解析后的形态 (schemastery >= 3.18.4 的 `volatile()`)。 */
interface VolatileRef {
  get(): unknown;
}

/** 是否为 volatile 引用。判定只看结构 —— 不 import 任何 @deepseek-ai 包 (跨版本稳定)。 */
export function isVolatileRef(value: unknown): value is VolatileRef {
  return (
    typeof value === "object" && value !== null && typeof (value as VolatileRef).get === "function"
  );
}

/**
 * 把 config 里的 volatile 引用接成设置源 (新宿主路径)。
 *
 * @param config 宿主传给 `apply` 的第二个参数 (可能是普通对象: 单测/旧宿主)。
 * @param keys schema 声明的设置字段名 (来自 `MEMORY_SETTING_KEYS`)。
 * @param source 设置源持有者; 接管成功后 `read()` 即返回面板当前值。
 * @returns 是否接管 (false = 一个引用都没找到, 调用方应走旧路径)。
 */
export function adoptVolatileSettings(
  config: unknown,
  keys: readonly string[],
  source: SettingsSource<HxMemorySettings>,
): boolean {
  if (typeof config !== "object" || config === null) return false;
  const holder = config as Record<string, unknown>;
  const present = keys.filter((key) => isVolatileRef(holder[key]));
  // 少一个引用就整体不接管: 半接管会得到"部分设置跟面板、部分跟默认值"的诡异状态,
  // 而那种状态在面板上表现为"某个开关怎么改都没用", 极难排查。宁可全部交回旧路径。
  if (present.length !== keys.length || present.length === 0) return false;
  // 返回的是"面板当前值"的部分视图 (schema 字段全覆盖, 类型上仍是 unknown 值);
  // 调用方 `settings()` 会用 DEFAULT_SETTINGS 兜底, 因此这里断言成 Partial 再交出去。
  source.adopt(
    () =>
      Object.fromEntries(
        present.map((key) => [key, (holder[key] as VolatileRef).get()]),
      ) as Partial<HxMemorySettings>,
  );
  return true;
}

/** 组装根需要的那一份: 读当前生效设置的函数 + 它背后的源 + 组合层配置。 */
export interface LiveSettings {
  /** 读当前生效设置 (默认值补全)。每次调用都重新求值 —— 面板改动当轮生效。 */
  read(): HxMemorySettings;
  /** 设置源本身 (旧宿主回退路径要 `adopt` 它)。 */
  source: SettingsSource<HxMemorySettings>;
  /**
   * 组合层配置 (默认值已补全)。
   *
   * 为什么必须交出去而不是让调用方拿 `opts.settings`: 旧宿主 (0.1.1) 的
   * `register(ns, schema, { base })` 要的是一份**完整**的 base —— 传裸 `opts.settings`
   * (通常只有零星几项, 甚至 `{}`) 会让宿主那边除这几项外的字段全是 undefined,
   * 表现为"面板里大部分设置读出来是空的"。这条回归真实发生过 (settings-adoption 测试抓到)。
   */
  composition: HxMemorySettings;
  /** 是否已由 volatile 引用接管 (0.1.7+)。 */
  readonly adopted: boolean;
}

/**
 * 建"当前生效设置"的唯一入口 (组装根只调这一行)。
 *
 * 为什么把这三步收在一处而不是散在组装根: 它们的**顺序是硬约束** ——
 *
 *   1. 先算组合配置 (插件 entry 的 config 是 base);
 *   2. 再把 schema 里的 volatile 引用接上 (0.1.7+; 找不到引用就保持组合配置, 等
 *      `wireSettings` 走旧宿主路径);
 *   3. 最后才把 `read` 交出去用。
 *
 * 顺序写错的表现是"设置看着像生效了、其实读的是默认值", 而**没有任何报错**。
 * 收成一个函数后, 顺序由代码结构保证, 不由调用点的记忆保证。
 */
export function createLiveSettings(
  composition: Partial<HxMemorySettings>,
  pluginOptions: unknown,
): LiveSettings {
  const compositionSettings: HxMemorySettings = { ...DEFAULT_SETTINGS, ...composition };
  const source = createSettingsSource<HxMemorySettings>(compositionSettings);
  const adopted = adoptVolatileSettings(pluginOptions, MEMORY_SETTING_KEYS, source);
  return {
    read: () => ({ ...DEFAULT_SETTINGS, ...source.read() }),
    source,
    composition: compositionSettings,
    adopted,
  };
}
