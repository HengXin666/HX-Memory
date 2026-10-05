// src/adapters/dsh/client/register-card.ts — 「记忆注入」设置卡的注册 (纯逻辑, 不碰 DOM/JSX)。
//
// 单独成模块的理由有两条:
//   1) 可测: node 环境的测试能直接断言"注册成什么形状", 而不必把 .tsx 组件树拖进 kernel 的
//      tsc 程序 (那份 tsconfig 没有 DOM lib —— 真实踩过);
//   2) 契约集中: 这一段是**版本最容易漂的地方**, 集中一处并带测试。
//
// ## 0.1.7 把这张卡的两半都换了 (2026-09-29 实测)
//
//   旧: 槽位 `settings.plugin.item`, key = 设置命名空间; 作用域来自服务 `settingsScope.bind()`。
//   新: 槽位 `plugins.bundle.config`, key = **包名** (在 Plugins 页的 bundle 详情页里渲染);
//       作用域来自服务 `configForms.get(entryId)`。
//   实证: `settings.plugin.item` 与 `settingsScope` 在全仓 0.1.7 里**零命中**; 而
//   `settings.describe()` 实测仍会返回 `autoGenerate` —— 但它在新宿主客户端**没有任何
//   渲染消费者** (只在 wire/schema 里出现), 所以"只要标了 volatile 就会自动出现表单"
//   是错的: 没有槽位注册, 这个命名空间在界面上就没有入口。
//
// 好消息: 两代作用域的**返回面同形** (getSnapshot / subscribe / set / unset), 因此卡片组件
// 一行都不用改 —— 变的只是"到哪里取"与"注册到哪个槽位", 两件事都收在本模块里。
import type { SettingsScopeLike } from "./settings-scope.js";

/** 宿主设置命名空间: 必须等于 runtime 条目的 entry id (见 dsh/cordis.patch.yml 顶部说明)。 */
export const MEMORY_SETTINGS_NAMESPACE = "hx-memory";
/** 本包的包名 —— 也是一些槽位的 key。 */
export const MEMORY_PACKAGE_NAME = "@hengxin666/hx-memory";
/** 卡片文案的 locale 命名空间。 */
export const CARD_LOCALE_NAMESPACE = "hx-memory.injection";

/** 本模块用到的宿主 context 面 (只声明用到的部分, 便于测试用最小桩)。 */
export interface CardHost {
  get(name: string): unknown;
  slots: {
    inject(slot: string, register: () => void): void;
    register(spec: unknown, component: unknown): unknown;
  };
}

export interface CardDependencies {
  /** 卡片组件 (由 index.tsx 注入, 保持本模块无 JSX)。 */
  component: unknown;
  /** 卡片文案取值函数。 */
  t: (key: string, vars?: Record<string, unknown>) => string;
}

/**
 * 解析宿主在本命名空间上的配置作用域; 两代宿主都取不到时返回 null。
 *
 * 判据是**能力**而不是版本号: 先试 0.1.7 的 `configForms.get(entryId)`, 再退回 <= 0.1.6 的
 * `settingsScope.bind({ namespace })`。两者返回面的交集正好是卡片需要的四个方法。
 *
 * 为什么经 `ctx.get` 而不是 `ctx.configForms`: cordis 的上下文代理对"没在 inject 里声明的
 * 服务"直接抛错, 而本插件不该为一张可选卡片把宿主设置包变成硬依赖 (声明进 inject 会让整个
 * 客户端插件在缺它时挂起, 连绑定/审阅面板一起没了)。
 */
export function resolveSettingsScope(ctx: CardHost): SettingsScopeLike | null {
  const forms = ctx.get("configForms") as
    | { get(entryId: string): SettingsScopeLike | undefined }
    | undefined;
  const fromForms = forms?.get(MEMORY_SETTINGS_NAMESPACE);
  if (fromForms) return fromForms;
  const legacy = ctx.get("settingsScope") as
    | { bind(spec: { namespace: string }): SettingsScopeLike }
    | undefined;
  return legacy?.bind({ namespace: MEMORY_SETTINGS_NAMESPACE }) ?? null;
}

/**
 * 把「记忆注入」卡注册到宿主「设置 → 插件 → 本插件」页。
 *
 * 为什么**注册时**就去拿 scope 是错的: 客户端插件之间没有声明依赖, 本插件的 apply 完全
 * 可能与承载这些服务的插件加载交错 —— apply 时 `ctx.get(...)` 返回 undefined, 卡片就永远
 * 不会出现, 而且没有任何报错 (本仓库踩过同类"静默不注册"的坑)。
 * 因此这里**无条件注册** (key 只是字符串), 把 scope 的解析推迟到宿主真正渲染卡片时
 * (inject 钩子), 那时服务必然已就位。宿主没有该槽位时没人渲染它, 不会留下可见残留。
 */
export function registerInjectionCard(ctx: CardHost, deps: CardDependencies): void {
  // 0.1.7+: bundle 详情页的配置区 (keyed by 包名)。
  ctx.slots.inject("plugins.bundle.config", () =>
    ctx.slots.register(
      {
        name: "plugins.bundle.config",
        key: MEMORY_PACKAGE_NAME,
        locale: CARD_LOCALE_NAMESPACE,
        inject: () => ({ scope: resolveSettingsScope(ctx), t: deps.t }),
      },
      deps.component,
    ),
  );
  // <= 0.1.6: 旧的 plugin.item 槽位。宿主没有它时 `inject` 只是挂着等 (不会报错),
  // 因此两条同时注册是安全的 —— 哪代宿主的槽位存在, 就在哪里出现一张卡。
  ctx.slots.inject("settings.plugin.item", () =>
    ctx.slots.register(
      {
        name: "settings.plugin.item",
        key: MEMORY_SETTINGS_NAMESPACE,
        locale: CARD_LOCALE_NAMESPACE,
        inject: () => ({ scope: resolveSettingsScope(ctx), t: deps.t }),
      },
      deps.component,
    ),
  );
}
