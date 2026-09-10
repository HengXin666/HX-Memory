// src/adapters/dsh/client/index.tsx — HX-Memory 的 DSH Web client 插件入口。
// 挂两个 settings 区段: 记忆绑定 (hx-memory-bindings) 与 推广审阅 (hx-memory-review)。
// 经 build-client.mjs 打成宿主可加载的包 (模块 id = 包名, 见 scripts/lib/wrap-client-bundle.mjs)。
import { BindingsPage, type BindingRpc } from "./bindings-page.js";
import { ReviewPage, type ReviewRpc } from "./review-page.js";
import { bindingEn, bindingZh, reviewEn, reviewZh } from "./locale.js";
import { styles } from "./styles.js";
import type { HxMemoryRpcCaller } from "./rpc.js";

const NS = "hx-memory.review";
const BIND_NS = "hx-memory.bindings";

interface ClientContext {
  get(name: string): { rpc: HxMemoryRpcCaller };
  effect(factory: () => (() => void) | void, label: string): void;
  locale: {
    bind(namespace: string): (key: string) => string;
    register(namespace: string, dictionaries: Record<string, Record<string, string>>): () => void;
  };
  slots: {
    inject(slot: string, register: () => void): void;
    register(spec: unknown, component: unknown): unknown;
  };
}

type Dictionary = typeof reviewEn;

export const inject = ["slots", "locale", "connection"];

export function apply(ctx: ClientContext): void {
  ctx.effect(
    () => ctx.locale.register(NS, { en: reviewEn, zh: reviewZh }),
    "hxMemory.reviewLocale()",
  );
  ctx.effect(
    () => ctx.locale.register(BIND_NS, { en: bindingEn, zh: bindingZh }),
    "hxMemory.bindingsLocale()",
  );
  const t = (key: keyof Dictionary, vars?: Record<string, unknown>) => {
    const raw = ctx.locale.bind(NS)(String(key)) || key;
    if (!vars) return raw;
    return raw.replace(/\{(\w+)\}/g, (_m, name: string) => String(vars[name] ?? ""));
  };
  ctx.effect(() => {
    const tag = document.createElement("style");
    tag.dataset.pluginCss = "hx-memory/review";
    tag.textContent = styles;
    document.head.appendChild(tag);
    return () => tag.remove();
  }, "hxMemory.reviewStyles()");
  const { rpc } = ctx.get("connection");
  // 两个面板都带 {var} 插值 (部分文案形如 "{n} 个绑定"): 绑定页原先漏了这一步,
  // 结果把 "{n}" 原样显示给用户 —— 由渲染冒烟测试抓出来。
  const tBind = (key: keyof typeof bindingEn, vars?: Record<string, unknown>) => {
    const raw = ctx.locale.bind(BIND_NS)(String(key)) || String(key);
    if (!vars) return raw;
    return raw.replace(/\{(\w+)\}/g, (_m, name: string) => String(vars[name] ?? ""));
  };
  ctx.slots.inject("settings.section", () =>
    ctx.slots.register(
      {
        name: "settings.section",
        id: "hx-memory-bindings",
        order: 41,
        label: () => ctx.locale.bind(BIND_NS)("nav"),
        inject: () => ({ rpc, t: tBind }),
      },
      BindingsPage,
    ),
  );
  ctx.slots.inject("settings.section", () =>
    ctx.slots.register(
      {
        name: "settings.section",
        id: "hx-memory-review",
        order: 40,
        label: () => ctx.locale.bind(NS)("nav"),
        inject: () => ({ rpc, t }),
      },
      ReviewPage,
    ),
  );
}

export type { ReviewRpc, BindingRpc };
