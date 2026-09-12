// tests/s2/client-injection-card.test.ts — 「记忆注入」设置卡的接线回归 (宿主设置面板)。
//
// 为什么必须钉住它: 宿主只渲染"服务端提供的命名空间 ∩ 有卡片认领的命名空间"
// (dsh-client-ui-settings-plugins 的 ConfigurablePluginsTabController), 而认领的方式是
// settings.plugin.item 槽位上 **key = 设置命名空间** 的注册。key 写错 = 开关在界面上
// 完全不存在 —— 而"看不到"与"没实现"在用户眼里是同一件事 (本仓库真实踩过)。
//
// 为什么只 import 纯 .ts 模块 (不 import .tsx): 仓库的 kernel tsconfig 不含 DOM lib,
// 只要 node 环境的测试碰一下 .tsx, 整棵组件树就被拉进类型检查并报 "Cannot find name
// 'document'" —— 所以注册逻辑与显示判定都被刻意抽到无 JSX 的模块里, 这里就能直接断言。
import { describe, expect, it } from "vitest";
import { modeOf, settledTo } from "../../src/adapters/dsh/client/injection-mode.ts";
import {
  CARD_LOCALE_NAMESPACE,
  MEMORY_SETTINGS_NAMESPACE,
  registerInjectionCard,
  resolveSettingsScope,
} from "../../src/adapters/dsh/client/register-card.ts";
import { cardEn, cardZh } from "../../src/adapters/dsh/client/locale.ts";

interface Registration {
  name?: string;
  key?: string;
  locale?: string;
  inject?: () => unknown;
  component: unknown;
}

/** 宿主桩: withSettingsScope=false 模拟"没装 ui-settings"。 */
function makeHost(options: { withSettingsScope?: boolean } = {}) {
  const registrations: Registration[] = [];
  const bound: string[] = [];
  const scope = {
    getSnapshot: () => ({ status: "ready", value: { injectMode: "every-turn" }, writable: true }),
    subscribe: () => () => {},
    set: async () => {},
    unset: async () => {},
  };
  let available = options.withSettingsScope !== false;
  const ctx = {
    get: (name: string) =>
      name === "settingsScope" && available
        ? {
            bind: (spec: { namespace: string }) => {
              bound.push(spec.namespace);
              return scope;
            },
          }
        : undefined,
    slots: {
      inject: (_slot: string, register: () => void) => register(),
      register: (spec: Registration, component: unknown) => {
        registrations.push({ ...spec, component });
        return () => {};
      },
    },
  };
  return {
    ctx,
    registrations,
    bound,
    /** 模拟宿主插件后来才加载完成 (apply 时还没有 ui-settings)。 */
    lateMount: () => {
      available = true;
    },
  };
}

const component = () => null;
const t = (key: string) => key;

describe("记忆注入卡接在宿主设置面板上", () => {
  it("用 settings.plugin.item + key=设置命名空间 认领 (key 错 = 面板里看不到开关)", () => {
    const { ctx, registrations, bound } = makeHost();
    registerInjectionCard(ctx as never, { component, t });
    const card = registrations.find((r) => r.name === "settings.plugin.item");
    expect(card, "必须注册 settings.plugin.item 卡片").toBeDefined();
    expect(card!.key).toBe(MEMORY_SETTINGS_NAMESPACE);
    expect(card!.locale).toBe(CARD_LOCALE_NAMESPACE);
    expect(card!.component).toBe(component);
    // 卡片拿到的是宿主 settingsScope (写权威值), 不是自家 RPC。
    const injected = card!.inject?.() as { scope?: unknown; t?: unknown };
    expect(injected.scope).toBeDefined();
    expect(typeof injected.t).toBe("function");
    expect(bound).toEqual([MEMORY_SETTINGS_NAMESPACE]);
  });

  it("注册时 ui-settings 还没加载完 → 仍然注册, 渲染时才解析 (避免卡片静默消失)", () => {
    // 真实风险: 客户端插件之间没有声明依赖, apply 完全可能与 ui-settings 的加载交错。
    // 若在 apply 时就要求 scope 存在, 那时拿到 undefined 的插件会**永远**没有卡片 —— 且无报错。
    const { ctx, registrations, lateMount } = makeHost({ withSettingsScope: false });
    registerInjectionCard(ctx as never, { component, t });
    expect(registrations.some((r) => r.name === "settings.plugin.item")).toBe(true);
    const card = registrations.find((r) => r.name === "settings.plugin.item")!;
    // 渲染前宿主才就位 → inject 这一刻必须能拿到 scope。
    lateMount();
    const injected = card.inject?.() as { scope?: unknown };
    expect(injected.scope, "迟到的 ui-settings 也必须被认到").toBeDefined();
  });

  it("宿主始终没有 ui-settings → scope 解析为 null (卡片不在任何地方被渲染)", () => {
    const { ctx } = makeHost({ withSettingsScope: false });
    expect(resolveSettingsScope(ctx as never)).toBeNull();
  });
});

describe("卡片把「当前模式」读对", () => {
  it("first 就是 first, 其余 (未加载/未知) 一律按 every-turn 显示", () => {
    expect(modeOf({ value: { injectMode: "first" } })).toBe("first");
    expect(modeOf({ value: { injectMode: "every-turn" } })).toBe("every-turn");
    // 关键: 值还没加载出来时**不能**显示成 first —— 那会让用户以为开关已经生效。
    expect(modeOf({ status: "loading" })).toBe("every-turn");
    expect(modeOf({ value: {} })).toBe("every-turn");
    expect(modeOf({ value: { injectMode: "garbage" } })).toBe("every-turn");
  });

  it("写成功与否看**回调后读回的权威值**, 不看 promise 有没有 reject", () => {
    // 宿主冲突时会自行回滚并重新广播: 这种情况下 set() 正常 settle, 但值还是旧的 ——
    // 只认 settle 就会把"其实没改成"报成"已保存"。
    const reverted = { getSnapshot: () => ({ value: { injectMode: "every-turn" } }) };
    const applied = { getSnapshot: () => ({ value: { injectMode: "first" } }) };
    expect(settledTo(reverted as never, "first")).toBe(false);
    expect(settledTo(applied as never, "first")).toBe(true);
  });
});

describe("卡片文案", () => {
  it("中英键集合一致且都非空 (缺一条就是界面上露出裸 key)", () => {
    expect(Object.keys(cardZh).sort()).toEqual(Object.keys(cardEn).sort());
    for (const key of Object.keys(cardEn) as (keyof typeof cardEn)[]) {
      expect(cardEn[key], "英文文案不得为空: " + key).toBeTruthy();
      expect(cardZh[key], "中文文案不得为空: " + key).toBeTruthy();
    }
  });
});

