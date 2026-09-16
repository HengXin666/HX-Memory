// adapters/dsh/settings-wiring.ts — 把宿主设置服务接到插件上 (兼容三版宿主 API)。
//
// 为什么独立成文件: 这段代码的形状完全由**宿主版本差异**决定 (installSection / register / 都没有),
// 而它与"记忆怎么工作"毫无关系 —— 它是适配层里最纯的适配。整段搬走后组装根回到可通读规模。
//
// 一条不能丢的契约: `setSource` 必须接住宿主给的**权威配置 thunk**, 而不是快照。
// 早期踩过的坑: 拿一次快照意味着用户在面板里改的设置永远不生效 (而代码看起来完全正确)。
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
 */
export function wireSettings(deps: SettingsWiringDeps): void {
  const { ctx, compositionSettings, settingsSource } = deps;
  // 设置: 宿主提供 installSection 时把用户层接进来 (必须接住 setSource 的 thunk,
  // 否则用户改的设置永远不会被读到); 旧宿主没有这个方法就退回组合配置。
  ctx.inject(["settings"], (settingsCtx) => {
    const service = settingsCtx.settings as unknown as {
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
    if (typeof service.installSection === "function") {
      // 0.1.2+: installSection 把"权威配置 thunk"交给消费方 (必须接住)。
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
          "host settings service exposes neither installSection nor register; using composition settings only",
        );
    } catch {
      // 日志失败不影响功能
    }
  });
}
