// src/adapters/dsh/index.ts — HX-Memory 的 DSH (cordis) 插件入口。
// 接线:
//   agent/session-start → 注入记忆指引 (只指引不注入历史)
//   agent/pre-step      → 声明式绑定确定性注入 (见 prestep.ts)
//   session/event       → 聚合 turn → 批量捕获入记忆 (见 runtime.ts)
//   ctx.tools.register  → memory_search / memory_save / memory_rule_propose
//   ctx.settings        → 可配置开关 (经 installSection 接住宿主权威配置源)
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-settings";
import { FileBackend } from "../../storage/file-store.js";
import { CapturePipeline } from "../../capture/pipeline.js";
import { memoryGuidance, MEMORY_PLUGIN_SOURCE } from "./guidance.js";
import {
  HxMemoryRuntime,
  projectOfSession,
  type SessionEventLike,
  type SessionLike,
} from "./runtime.js";
import { makePreStepHandler, priorInjections } from "./prestep.js";
import { registerMemoryTools } from "./tools.js";
import { EpisodeStore } from "../../storage/episode-store.js";
import { GeneralizerService } from "../../generalize/service.ts";
import { makeLlmAbstractor } from "./llm-abstractor.js";
import { makeLlmStructurer } from "./llm-structurer.js";
import { RecallService } from "../../recall/service.ts";
import { HybridRetriever } from "../../retrieval/hybrid.js";
import { MemoryFacade } from "../../app/facade.js";
import { MemoryNormalizer } from "../../app/normalize.ts";
import { LexicalEmbedder } from "../../retrieval/embedding-lexical.js";
import { LinearVectorIndex } from "../../retrieval/vector.js";
import { ProjectedVectorIndex } from "../../retrieval/vector-projected.js";
import { openAiEmbedderFromEnv } from "../../retrieval/embedding-http.js";
import { Binder, type BindingConfig } from "../../kernel/binder.ts";
import { BindingStore } from "../../bindings/store.ts";
import { HxMemoryGateway } from "./gateway.js";
import { InvocationLog } from "./invocations.js";
import type { LlmInvocationRecord } from "./llm-agent.js";
import { DEFAULT_SETTINGS, type HxMemorySettings } from "./types.js";
import { Config, MEMORY_SETTINGS_NAMESPACE } from "./settings.js";
import { createSettingsSource } from "./settings-source.js";
import { createTriggerCache } from "./trigger-cache.js";

export const name = "hx-memory";
// 只硬依赖工具注册表: 事件监听不需要服务, 设置经 ctx.inject 可选接入,
// llm/agentDefaultModel 用 ctx.get 探测 (缺失时 AI 增强自动回退启发式, 插件照常工作)。
export const inject = ["tools"];

export interface HxMemoryPluginOptions {
  /** 记忆根目录 (默认 $DSH_HOME/hx-memory, 再退回 ~/.dsh/hx-memory)。 */
  root?: string;
  /** 存储层 (可选: 不传则用 root 自建默认 FileBackend)。 */
  store?: FileBackend;
  /** Review 队列目录 (可选: 默认 <root>/review)。 */
  reviewDir?: string;
  settings?: Partial<HxMemorySettings>;
  /** 声明式记忆绑定 (VCP 式记忆拓扑): 项目 → 绑定哪些记忆源。 */
  bindings?: BindingConfig[];
}

/**
 * 默认记忆根: $HX_MEMORY_ROOT → $DSH_HOME/hx-memory → ~/.dsh/hx-memory。
 * 跟随 DSH_HOME 很重要: 多实例/CI 用 DSH_HOME 隔离状态, 记忆根不能落在共享的 ~/.dsh。
 */
export function defaultMemoryRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (env.HX_MEMORY_ROOT?.trim()) return env.HX_MEMORY_ROOT.trim();
  const dshHome = env.DSH_HOME?.trim();
  if (dshHome) return resolve(dshHome, "hx-memory");
  return join(homedir(), ".dsh", "hx-memory");
}

/** 尝试构造 AI 能力; agents 服务不可用或构造失败 → undefined (调用方回退启发式)。 */
function safeAgent<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

export function apply(ctx: Context, options: HxMemoryPluginOptions = {}): void {
  const opts = options;
  const root = opts.root ?? defaultMemoryRoot();
  const store = opts.store ?? new FileBackend({ root });
  const reviewDir = opts.reviewDir ?? join(root, "review");
  // 组合配置 (插件 entry) 是 base; 宿主 settings 服务可用时以它的权威值覆盖。
  const compositionSettings: HxMemorySettings = { ...DEFAULT_SETTINGS, ...opts.settings };
  const settingsSource = createSettingsSource<HxMemorySettings>(compositionSettings);
  const settings = (): HxMemorySettings => ({ ...DEFAULT_SETTINGS, ...settingsSource.read() });

  const bindingStore = new BindingStore(root);
  // v2 检索器: 绑定注入 / 会话召回 / memory_search 三条路共用同一个检索语义
  // (能力自述来自存储引擎, 降级会写进 RetrievalResult.degraded)。
  // 向量通道: 配了 HX_MEMORY_EMBEDDING_BASE_URL/MODEL 就用真语义 (异步 + 投影),
  // 否则用本地零依赖哈希嵌入器 (同步, 零配置也能跑)。
  const httpEmbedder = openAiEmbedderFromEnv();
  const localEmbedder = new LexicalEmbedder();
  const retriever = new HybridRetriever(store, {
    vectorIndex: httpEmbedder
      ? new ProjectedVectorIndex({ embedder: httpEmbedder })
      : new LinearVectorIndex({ embedder: localEmbedder }),
  });
  // 使用层唯一 API: DSH 的工具/召回都经由它, 与 MCP/CLI 共用同一套语义 (ADR-021)。
  const facade = new MemoryFacade(
    { store, retriever },
    // 语义兜底去重默认开启 (本地零依赖哈希袋); 自动演化 (取代/冲突) 由设置控制。
    // 传函数: 面板里改 autoEvolve 当轮生效 (不再需要重启)。
    { embedder: localEmbedder, autoEvolve: () => settings().autoEvolve },
  );
  facade.withIndexStatus(() => store.ftsStatus());

  // 触发通道缓存 (always-on 保底 + 意图召回叠加); 失效策略见 trigger-cache.ts。
  const triggerCache = createTriggerCache({
    facade,
    revision: () => store.revision(),
    budgetTokens: 400,
  });
  const refreshAlwaysOn = (project?: string): Promise<void> => triggerCache.refresh(project);

  const binder = new Binder(
    (q) => store.query(q),
    () => {
      const saved = bindingStore.list();
      return saved.length ? saved : (opts.bindings ?? []);
    },
    retriever,
    // 通用触发通道 (无项目绑定时的兜底): always-on 保底 + 回忆意图门控。
    // 这是"AI 没意识到要查记忆"时记忆仍然生效的保证 (见 src/trigger/policy.ts)。
    {
      alwaysOn: () => triggerCache.ids(),
      recallFor: (text, decision) => triggerCache.recallFor(text, decision),
      now: () => new Date().toISOString(),
      warm: () => refreshAlwaysOn(),
      // 命中即强化: 确定性注入是每轮都在跑的主通道, 注入过的记忆必须算"被用到"。
      // Facade.reinforce 自带 60s 合并窗口 (同窗口内重复命中只写一次), 失败静默 (不拖垮注入)。
      onInjected: (ids) => {
        if (ids.length) void facade.reinforce(ids).catch(() => undefined);
      },
    },
  );
  // AI 结构化: 经 agents 服务调最小 agent; 不可用时 pipeline 自动回退启发式。
  const structurer = safeAgent(() => makeLlmStructurer(ctx, settings));
  const pipe = new CapturePipeline(store, { structurer: structurer ?? undefined });

  // AI 调用记录: 订阅宿主事件, 存环形缓冲供面板展示 (透明可审计)。
  const invocationLog = new InvocationLog();
  (ctx.on as (name: string, cb: (r: unknown) => void) => void)(
    "hx-memory/llm-invocation",
    (r: unknown) => {
      invocationLog.push(r as LlmInvocationRecord);
    },
  );
  // 记忆写入失败只记日志: DSH 把未处理的 rejection 当致命错误, 记忆层不能拖垮宿主。
  const logWarn = (message: string, error: unknown): void => {
    try {
      ctx.logger("hx-memory").warn(message, String(error));
    } catch {
      // 日志失败不影响宿主
    }
  };
  // Episode 追加日志 (ADR-018): 原文是真相的一部分, 让"换抽取器"能重放而不是重聊。
  // 可关闭 (captureEpisodes) 且带保留期; 关闭时记忆照常捕获, 只是没有原文可重放。
  // Episode 日志: 保留期与开关都要**实时**读设置 (面板改动不必重启)。
  // 保留期变化时重建实例 (EpisodeStore 的 prune 只在构造时读保留期)。
  let episodes: EpisodeStore | null = null;
  let episodesRetention = -1;
  const episodeStore = (): EpisodeStore | null => {
    if (!settings().captureEpisodes) return null;
    const retention = settings().episodeRetentionDays;
    if (!episodes || retention !== episodesRetention) {
      episodes = new EpisodeStore({ root, retentionDays: retention });
      episodesRetention = retention;
    }
    return episodes;
  };
  // 启动时清理过期原文 (只跑一次; 保留期改小后由下次 prune 生效)。
  try {
    const removed = episodeStore()?.prune() ?? 0;
    if (removed > 0) ctx.logger("hx-memory").info("pruned %d expired episodes", removed);
  } catch (error) {
    logWarn("episode prune failed: %s", error);
  }
  const runtime = new HxMemoryRuntime(pipe, settings, {
    onError: (error) => logWarn("capture failed: %s", error),
    surface: "dsh",
    episodes: () => episodeStore(),
  });
  // AI 推广抽象: 经 agents 服务调最小 agent 提炼规则; 不可用/失败时回退启发式。
  const generalizer = new GeneralizerService(
    store,
    reviewDir,
    safeAgent(() => makeLlmAbstractor(ctx, settings)),
    {
      onAbstractError: (error, cluster) => {
        try {
          ctx
            .logger("hx-memory")
            .warn(
              "abstractor failed for theme %s, fell back to heuristic: %s",
              cluster.theme,
              String(error),
            );
        } catch {
          // 日志失败不影响回退
        }
      },
    },
  );
  const recall = new RecallService((q) => store.query(q), retriever);

  // 挂载 Review Web 服务 (Typert Remote): Service 构造即注册, 随 fiber 自动卸载。
  // bindingStore 必须无条件注入 —— 否则面板 saveBindings 永远返回 "binding store not mounted"。
  ctx.effect(() => {
    new HxMemoryGateway(ctx, {
      store,
      generalizer,
      bindingStore,
      invocations: invocationLog,
      facade,
      // 主动整理 (面板 dryRun → 确认 → 写回) 与 CLI 共用同一实现。
      normalizer: { run: (opts) => new MemoryNormalizer(store, root).run(opts) },
      // 面板"当前项目"预填: 与捕获/绑定/召回同一派生口径 (仓库级键)。
      currentProject: () => runtime.project(),
    });
    return () => void 0; // Service 随 fiber 自动卸载, 无需手动清理
  }, "hx-memory.gateway()");

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

  // 工具注册
  ctx.effect(
    () => registerMemoryTools(ctx, { store, generalizer, retriever, facade }),
    "hx-memory.tools()",
  );

  // 生命周期
  ctx.effect(() => {
    void pipe.warmUp();
    // 向量索引预热: 首次检索若要现建索引会多花约 160ms (10k 条实测)。
    // 放在**启动后台**而不是组装期同步执行 —— 插件是长期驻留的, 启动时补一次就没有首次查询毛刺;
    // 但绝不能在 apply() 里同步做 (那会把成本转嫁成插件加载变慢, 对一次性 CLI 尤其亏)。
    // 失败静默: 检索时会自行同步, 行为不变 (只是慢一次)。
    setTimeout(() => {
      try {
        retriever.warmSync();
      } catch {
        // 预热失败不影响可用性
      }
    }, 0);
    // 卸载时冲刷缓冲: cordis 会 await 返回 promise 的 disposer, 所以这里必须把 promise 返回
    // 而不是 void 掉 (flushAll 里可能包含一次最长 15s 的 LLM 调用)。
    return () => runtime.flushAll();
  }, "hx-memory.lifecycle()");

  // 会话开始: 注入记忆指引 + 跨项目规则召回 (只注入规则, 不注入历史)
  ctx.on("agent/session-start", (payload: unknown) => {
    const agent = (
      payload as { agent: { ctx: Context; session: SessionLike; inject: (m: unknown) => void } }
    ).agent;
    runtime.onSessionStart(agent.session);
    // subagent 不注入指引/绑定: 它拿到的任务提示词由父 agent 组织, 塞记忆反而污染委派语义。
    // 与 runtime.capture 同口径: undefined 视为"过滤 subagent"。
    if (settings().rootAgentsOnly !== false && agent.session.header?.origin === "subagent") {
      return;
    }
    if (!settings().injectGuidance) return;
    const parts: string[] = [];
    const project = projectOfSession(agent.session) ?? agent.session.id;
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
    // 会话历史里已经有本插件的注入块 → 不再灌第二遍。
    // 实测同一会话会出现两份完全相同的指引 (session-start 被触发两次), 而它与预步的注入
    // 此前也无法互相判重 (标题/框架句不同) —— 同一批记忆因此会在一轮里出现两三次。
    const text = parts.join("\n\n");
    if (priorInjections(agent).has(text)) return;
    agent.inject(
      createUserMessage({
        content: [{ type: "text", text }],
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
      enabled: () => settings().injectBindings,
      warmupMs: () => settings().semanticWarmupMs,
      language: () => settings().language,
      projectOf: (payload) => projectOfSession(payload.agent.session) ?? payload.agent.session.id,
    }) as never,
  );

  // 捕获: DSH 的真实 SessionEvent 是内部联合类型, 这里用宽松结构接收 (仿 ReMe)。
  ctx.on("session/event", (session: unknown, event: unknown) => {
    void runtime
      .capture(session as SessionLike, event as SessionEventLike)
      .catch((error: unknown) => logWarn("capture failed: %s", error));
  });

  // 会话离开 store: 立即冲刷未落盘的 turn 并回收状态 (否则 autoMemoryInterval>1 时,
  // 已结束会话的缓冲会一直留到插件卸载)。
  ctx.on("session/disposed", (session: unknown) => {
    runtime.onSessionEnd(session as SessionLike);
  });
}

export type { HxMemorySettings } from "./types.js";
