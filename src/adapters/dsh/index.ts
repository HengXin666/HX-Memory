// src/adapters/dsh/index.ts — HX-Memory 的 DSH (cordis) 插件入口。
// 接线 (ReMe 验证过的模式):
//   agent/session-start → 注入记忆指引 (只指引不注入历史)
//   session/event        → 聚合 turn → 批量捕获入记忆
//   ctx.tools.register   → memory_search / memory_save
//   ctx.settings         → 可配置开关
import { homedir } from "node:os";
import { join } from "node:path";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-settings";
import { FileBackend } from "../../storage/file-store.js";
import { CapturePipeline } from "../../capture/pipeline.js";
import { memoryGuidance, MEMORY_PLUGIN_SOURCE } from "./guidance.js";
import { HxMemoryRuntime, type SessionEventLike, type SessionLike } from "./runtime.js";
import { makePreStepHandler } from "./prestep.js";
import { registerMemoryTools } from "./tools.js";
import { GeneralizerService } from "../../generalize/service.ts";
import { RecallService } from "../../recall/service.ts";
import { Binder, type BindingConfig } from "../../kernel/binder.ts";
import { BindingStore } from "../../bindings/store.ts";
import { HxMemoryGateway } from "./gateway.js";
import { DEFAULT_SETTINGS, type HxMemorySettings } from "./types.js";
import { Config, MEMORY_SETTINGS_NAMESPACE } from "./settings.js";

export const name = "hx-memory";
export const inject = ["agents", "sessions", "tools"];

export interface HxMemoryPluginOptions {
  /** 记忆根目录 (默认 ~/.dsh/hx-memory 或 $HX_MEMORY_ROOT)。 */
  root?: string;
  /** 存储层 (可选: 不传则用 root 自建默认 FileBackend)。 */
  store?: FileBackend;
  /** Review 队列目录 (可选: 默认 <root>/review)。 */
  reviewDir?: string;
  settings?: Partial<HxMemorySettings>;
  /** 声明式记忆绑定 (VCP 式记忆拓扑): 项目 → 绑定哪些记忆源。 */
  bindings?: BindingConfig[];
}

/** 默认记忆根: $HX_MEMORY_ROOT → ~/.dsh/hx-memory (与 DSH 的 dsh-home 惯例一致)。 */
export function defaultMemoryRoot(): string {
  return process.env.HX_MEMORY_ROOT ?? join(homedir(), ".dsh", "hx-memory");
}

export function apply(ctx: Context, options: HxMemoryPluginOptions = {}): void {
  const opts = options;
  const root = opts.root ?? defaultMemoryRoot();
  const store = opts.store ?? new FileBackend({ root });
  const reviewDir = opts.reviewDir ?? join(root, "review");
  const settings: () => HxMemorySettings = () => ({ ...DEFAULT_SETTINGS, ...opts.settings });
  const bindingStore = new BindingStore(root);
  const binder = new Binder(
    (q) => store.query(q),
    () => (root ? bindingStore.list() : (opts.bindings ?? [])),
  );
  const pipe = new CapturePipeline(store);
  const runtime = new HxMemoryRuntime(pipe, settings);
  const generalizer = new GeneralizerService(store, reviewDir);
  const recall = new RecallService((q) => store.query(q));

  // 挂载 Review Web 服务 (Typert Remote): Service 构造即注册, 随 fiber 自动卸载
  ctx.effect(() => {
    new HxMemoryGateway(ctx, {
      store,
      generalizer,
      bindingStore: options.root ? bindingStore : undefined,
    });
    return () => void 0; // Service 随 fiber 自动卸载, 无需手动清理
  }, "hx-memory.gateway()");

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

  // 会话开始: 注入记忆指引 + 跨项目规则召回 (只注入规则, 不注入历史)
  ctx.on("agent/session-start", (payload: unknown) => {
    const agent = (
      payload as { agent: { ctx: Context; session: SessionLike; inject: (m: unknown) => void } }
    ).agent;
    runtime.onSessionStart(agent.session);
    if (!settings().injectGuidance) return;
    const parts: string[] = [];
    const project = agent.session.id;
    const guidance = memoryGuidance(settings().language);
    // 新线 (VCP 式): 项目声明绑定 → 会话开始即确定性注入绑定规则集 (不依赖模型自觉)
    const bound = binder.injectFor(project, "");
    if (bound) {
      parts.push(bound);
      parts.push(guidance); // 工具通道作为补充 (VCP Agent 同时有绑定 + 主动检索)
    } else {
      // 旧线: 指引 + 全局规则召回 (靠模型自觉调 memory_search)
      parts.push(guidance);
      const recallOut = recall.recall({ project });
      if (recallOut.rules.length) parts.push(recallOut.injected);
    }
    if (!parts.length) return;
    agent.inject(
      createUserMessage({
        content: [{ type: "text", text: parts.join("\n\n") }],
        source: { kind: "plugin", plugin: MEMORY_PLUGIN_SOURCE, form: "instructions" },
      }),
    );
  });

  // 逐轮确定性注入 (VCP 式): 每步用最新用户文本做绑定检索注入, 不靠模型自觉。
  // 运行时契约已对照 dsh-agent-instructions 的权威实现验证 (waterfall: next() → 追加上下文消息)。
  // 类型: DSH 的 ctx.on 需要 dsh-agent 的 UserMessage[]/Agent 精确类型, 这里用受控断言收敛。
  ctx.on(
    "agent/pre-step",
    makePreStepHandler(binder, {
      rootAgentsOnly: () => settings().rootAgentsOnly,
      enabled: () => settings().injectGuidance,
    }) as never,
  );

  // 捕获: DSH 的真实 SessionEvent 是内部联合类型, 这里用宽松结构接收 (仿 ReMe)。
  ctx.on("session/event", (session: unknown, event: unknown) => {
    runtime.capture(session as SessionLike, event as SessionEventLike);
  });
}

export type { HxMemorySettings } from "./types.js";
