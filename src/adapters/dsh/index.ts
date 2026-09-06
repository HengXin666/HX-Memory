// src/adapters/dsh/index.ts — HX-Memory 的 DSH (cordis) 插件入口。
// 接线 (ReMe 验证过的模式):
//   agent/session-start → 注入记忆指引 (只指引不注入历史)
//   session/event        → 聚合 turn → 批量捕获入记忆
//   ctx.tools.register   → memory_search / memory_save
//   ctx.settings         → 可配置开关
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-settings";
import type { FileBackend } from "../../storage/file-store.js";
import { CapturePipeline } from "../../capture/pipeline.js";
import { memoryGuidance, MEMORY_PLUGIN_SOURCE } from "./guidance.js";
import { HxMemoryRuntime, type SessionEventLike, type SessionLike } from "./runtime.js";
import { registerMemoryTools } from "./tools.js";
import { DEFAULT_SETTINGS, type HxMemorySettings } from "./types.js";
import { Config, MEMORY_SETTINGS_NAMESPACE } from "./settings.js";

export const name = "hx-memory";
export const inject = ["agents", "sessions", "tools"];

export interface HxMemoryPluginOptions {
  /** 存储层: 由宿主注入 (可插拔 — 本仓库默认 FileBackend)。 */
  store: FileBackend;
  settings?: Partial<HxMemorySettings>;
}

export function apply(ctx: Context, options: HxMemoryPluginOptions): void {
  const { store } = options;
  const settings: () => HxMemorySettings = () => ({ ...DEFAULT_SETTINGS, ...options.settings });
  const pipe = new CapturePipeline(store);
  const runtime = new HxMemoryRuntime(pipe, settings);

  // 可选: 用 DSH 设置面板持久化 (若宿主提供 settings 服务)。
  // 经 @deepseek-ai/dsh-settings 的类型增强, ctx.settings 是真实服务类型。
  ctx.inject(["settings"], (settingsCtx) => {
    settingsCtx.settings.installSection(ctx, MEMORY_SETTINGS_NAMESPACE, Config, settings(), {
      setSource: () => void 0,
      onChange: () => void 0,
      validate: () => void 0,
    });
  });

  // 工具注册
  ctx.effect(() => registerMemoryTools(ctx, { store }), "hx-memory.tools()");

  // 生命周期
  ctx.effect(() => {
    void pipe.warmUp();
    return () => runtime.onSessionEnd({ id: "*" });
  }, "hx-memory.lifecycle()");

  // 会话开始: 注入记忆指引 (只指引, 不注入历史)
  ctx.on("agent/session-start", (payload: unknown) => {
    const agent = (
      payload as { agent: { ctx: Context; session: SessionLike; inject: (m: unknown) => void } }
    ).agent;
    runtime.onSessionStart(agent.session);
    if (!settings().injectGuidance) return;
    agent.inject(
      createUserMessage({
        content: [{ type: "text", text: memoryGuidance(settings().language) }],
        source: { kind: "plugin", plugin: MEMORY_PLUGIN_SOURCE, form: "instructions" },
      }),
    );
  });

  // 捕获: DSH 的真实 SessionEvent 是内部联合类型, 这里用宽松结构接收 (仿 ReMe)。
  ctx.on("session/event", (session: unknown, event: unknown) => {
    runtime.capture(session as SessionLike, event as SessionEventLike);
  });
}

export type { HxMemorySettings } from "./types.js";
