// src/adapters/dsh/client/index.tsx — HX-Memory 的 DSH Web client 插件入口。
// 挂一个 settings 区段: 推广审阅页。经 build-client.mjs 打成 DSH host 可加载的包。
import { useState } from "react";
import { ReviewPage, type ReviewRpc } from "./review-page.js";
import { reviewEn, reviewZh } from "./locale.js";
import { styles } from "./styles.js";

const NS = "hx-memory.review";
const SETTINGS_NS = "hx-memory";

interface ClientContext {
  get(name: string): { rpc: ReviewRpc };
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
  const t = (key: keyof Dictionary, vars?: Record<string, unknown>) => {
    const raw = ctx.locale.bind(NS)(String(key)) || key;
    if (!vars) return raw;
    return raw.replace(/\{(w+)\}/g, (_m, name: string) => String(vars[name] ?? ""));
  };
  ctx.effect(() => {
    const tag = document.createElement("style");
    tag.dataset.pluginCss = "hx-memory/review";
    tag.textContent = styles;
    document.head.appendChild(tag);
    return () => tag.remove();
  }, "hxMemory.reviewStyles()");
  const { rpc } = ctx.get("connection");
  ctx.slots.inject("settings.section", () =>
    ctx.slots.register(
      {
        name: "settings.section",
        id: "hx-memory-review",
        order: 40,
        label: () => ctx.locale.bind(NS)("nav"),
        meta: { icon: "memory" },
        locale: NS,
        inject: () => ({ rpc, t }),
      },
      ReviewPage,
    ),
  );
}
