// src/adapters/dsh/settings-wiring.ts — 把宿主设置服务接到插件上 (兼容三代宿主 API)。
//
// 为什么独立成文件: 这段代码的形状完全由**宿主版本差异**决定 (volatile 引用 / installSection /
// register / 都没有), 而它与"记忆怎么工作"毫无关系 —— 它是适配层里最纯的适配。
//
// ## 三代宿主的接入方式 (2026-09-29 实测补齐)
//
//   1. **0.1.7+ (当前)**: `installSection` / `register` **都已从 SettingsForms 删除**。
//      宿主改为自动投影 `entry.fiber.runtime.Config`, 并把标了 `.volatile()` 的字段解析成
//      引用对象传进 `apply(ctx, config)`。接入动作因此**发生在 apply 之前**:
//      由 `adoptVolatileSettings()` 读那些引用 (见 settings-live.ts), 本函数此时无事可做,
//      只需让宿主知道"这个条目有专属设置卡, 不要自动生成页面"。
//   2. **0.1.2 ~ 0.1.6**: `installSection(owner, ns, schema, entry, hooks)` 交出权威 thunk。
//      一条不能丢的契约: 必须接住 `setSource` 的 **thunk**, 而不是快照 ——
//      拿一次快照意味着用户改的设置永远不生效 (而代码看起来完全正确)。
//   3. **0.1.1**: 只有 `register(ns, schema, { base })`。
//
// 三代都不可用时**明确抱怨一句** (静默退化会让"设置不生效"无从排查)。
import type { Context } from "@deepseek-ai/cordis";
import type { HxMemorySettings } from "./types.js";
import { Config, MEMORY_SETTINGS_NAMESPACE } from "./settings.js";
import type { createSettingsSource } from "./settings-source.js";

export interface SettingsWiringDeps {
  ctx: Context;
  compositionSettings: Partial<HxMemorySettings>;
  settingsSource: ReturnType<typeof createSettingsSource>;
}

/**
 * 注册设置: 优先 `installSection` (0.1.2+, 交出权威 thunk), 退回 `register` (0.1.1),
 * 都没有则只用组合配置并**明确抱怨一句** (静默退化会让"设置不生效"无从排查)。
 *
 * 注意: 0.1.7+ 走的是**另一条**路径 —— 那些宿主上 `settingsSource` 已经被 volatile 引用接管
 * (`adopted === true`), 本函数会跳过两个旧入口, 只做"关掉自动生成页面"这一件事。
 */
export function wireSettings(deps: SettingsWiringDeps): void {
  const { ctx, compositionSettings, settingsSource } = deps;
  ctx.inject(["settings"], (settingsCtx) => {
    const service = settingsCtx.settings as unknown as {
      configure?: (presentation: { auto?: boolean }, owner?: unknown) => () => void;
      installSection?: (
        owner: Context,
        ns: string,
        schema: unknown,
        entry: unknown,
        hooks: {
          setSource: (current: () => unknown) => void;
          onChange: () => void;
          validate?: (value: unknown) => void;
        },
      ) => void;
      /** 0.1.1 的注册入口 (返回带 get() 的 owner scope)。 */
      register?: (
        ns: string,
        schema: unknown,
        options?: { base?: Partial<HxMemorySettings> },
      ) => { get: () => unknown };
    };

    // ── 0.1.7+: volatile 引用已在 apply 前接管, 两个旧入口都不存在 ────────────────
    // 这一支必须排在旧入口之前: 否则一旦宿主同时留着 configure 与 installSection,
    // 我们会对同一命名空间注册两次。
    //
    // `auto` 必须是 **true** (显式写出来, 而不是省略): 新宿主把「设置 → 插件」页的
    // 表单改成**按 schema 自动生成**, 而 `auto:false` 的语义是"本插件自带设置页, 别生成"。
    // 自带页在 0.1.7 上已经不存在了 (旧槽位 `settings.plugin.item` 与 `settingsScope`
    // 服务一起被删除, 实测全仓搜不到) —— 于是 `auto:false` 会得到一个**空页面**:
    // 命名空间注册着、21 个字段一个都看不见, 而且不报错。
    // 这是本轮"插件看着好好的、设置却改不了"的直接成因, 因此这里显式写 true 并留下理由。
    if (typeof service.configure === "function") {
      settingsCtx.effect(
        () => service.configure!({ auto: true }, ctx.fiber),
        "hx-memory.settingsForm()",
      );
      return;
    }

    if (typeof service.installSection === "function") {
      // 0.1.2 ~ 0.1.6: installSection 把"权威配置 thunk"交给消费方 (必须接住)。
      service.installSection(ctx, MEMORY_SETTINGS_NAMESPACE, Config, compositionSettings, {
        setSource: (current) => {
          settingsSource.adopt(() => current() as HxMemorySettings);
        },
        onChange: () => {
          // 每次读取都走 settingsSource.read(), 无需缓存失效
        },
        validate: () => {
          // schema 已经校验过取值范围; 这里没有额外约束
        },
      });
      return;
    }
    if (typeof service.register === "function") {
      // 0.1.1: 只有 register(ns, schema, { base }) → 用组合配置做 base, 每次读取走 scope.get()。
      const scope = service.register(MEMORY_SETTINGS_NAMESPACE, Config, {
        base: compositionSettings,
      });
      settingsSource.adopt(() => scope.get() as HxMemorySettings);
      return;
    }
    try {
      ctx
        .logger("hx-memory")
        .warn(
          "host settings service exposes neither volatile-config references, configure, installSection nor register; using composition settings only",
        );
    } catch {
      // 日志失败不影响功能
    }
  });
}
