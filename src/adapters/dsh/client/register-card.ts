// src/adapters/dsh/client/register-card.ts — 「记忆注入」设置卡的注册 (纯逻辑, 不碰 DOM/JSX)。
//
// 单独成模块的理由有两条:
//   1) 可测: node 环境的测试能直接断言"注册成什么形状", 而不必把 .tsx 组件树拖进 kernel 的
//      tsc 程序 (那份 tsconfig 没有 DOM lib —— 真实踩过);
//   2) 契约集中: 宿主 dsh-client-ui-settings-plugins 只渲染 **服务端提供的命名空间 ∩
//      在 settings.plugin.item 上认领了该命名空间的卡片**。key 写错 = 开关在界面上不存在,
//      而"看不到"与"没实现"在用户眼里是同一件事。这条契约放在一处并带测试。
import type { SettingsScopeLike } from "./settings-scope.js";

/** 宿主设置命名空间: 与 src/adapters/dsh/settings.ts 的 MEMORY_SETTINGS_NAMESPACE 必须一致。 */
export const MEMORY_SETTINGS_NAMESPACE = "hx-memory";
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
 * 解析宿主 settingsScope 在本命名空间上的绑定; 宿主没装 ui-settings 时返回 null。
 *
 * 为什么经 `ctx.get` 而不是 `ctx.settingsScope`: cordis 的上下文代理对"没在 inject 里声明
 * 的服务"直接抛错, 而本插件不该为一张可选卡片把 ui-settings 变成硬依赖 (声明进 inject 会让
 * 整个客户端插件在缺 ui-settings 时挂起, 连绑定/审阅面板一起没了)。
 */
export function resolveSettingsScope(ctx: CardHost): SettingsScopeLike | null {
  const service = ctx.get("settingsScope") as
    | { bind(spec: { namespace: string }): SettingsScopeLike }
    | undefined;
  return service?.bind({ namespace: MEMORY_SETTINGS_NAMESPACE }) ?? null;
}

/**
 * 把「记忆注入」卡注册到宿主「设置 → 插件」页。
 *
 * 为什么**注册时**就去拿 scope 是错的: 客户端插件之间没有声明依赖, 本插件的 apply 完全
 * 可能与 ui-settings 的加载交错 —— apply 时 `ctx.get("settingsScope")` 返回 undefined,
 * 卡片就永远不会出现, 而且没有任何报错 (本仓库踩过同类"静默不注册"的坑)。
 * 因此这里**无条件注册** (key 只是字符串), 把 scope 的解析推迟到宿主真正渲染卡片时
 * (inject 钩子), 那时 ui-settings 必然已经就位。宿主没有 ui-settings 时这个槽位根本没人
 * 渲染, 所以"无条件注册"不会留下任何可见残留。
 */
export function registerInjectionCard(ctx: CardHost, deps: CardDependencies): void {
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

