// src/adapters/dsh/index.ts — HX-Memory 的 DSH (cordis) 插件入口。
// 接线:
//   agent/session-start → 注入记忆指引 (只指引不注入历史)
//   agent/pre-step      → 声明式绑定确定性注入 (见 prestep.ts)
//   session/event       → 聚合 turn → 批量捕获入记忆 (见 runtime.ts)
//   ctx.tools.register  → memory_search / memory_save / memory_rule_propose
//   ctx.settings        → 可配置开关 (经 installSection 接住宿主权威配置源)
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-settings";
import { FileBackend } from "../../storage/file-store.js";
import { CapturePipeline } from "../../capture/pipeline.js";
import { makeSessionStartHandler } from "./session-start.js";
import {
  HxMemoryRuntime,
  projectOfSession,
  type SessionEventLike,
  type SessionLike,
} from "./runtime.js";
import { makePreStepHandler } from "./prestep.js";
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
import { HXMEM_REMOTE_METHODS } from "./remote-methods.js";
import { assertRemoteContract, remoteContract } from "./remote-contract.js";
import { InvocationLog } from "./invocations.js";
import type { LlmInvocationRecord } from "./llm-agent.js";
import { DEFAULT_SETTINGS, type HxMemorySettings } from "./types.js";
import { createSettingsSource } from "./settings-source.js";
import { createTriggerCache } from "./trigger-cache.js";
import { ScheduleLog } from "./schedule-log.js";
import { CaptureLog } from "./capture-log.js";
import { wireMaintenance } from "./maintenance-wiring.js";
import { wireSettings } from "./settings-wiring.js";
import { wireLifecycle } from "./lifecycle-wiring.js";

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
  // 谁创建谁关闭: FileBackend 持有 SQLite 句柄, 热重载 (HMR 会 dispose 旧 fiber 再 apply())
  // 时若不关, 每次重载漏一个句柄并叠加 WAL 争用, 最终 "database is locked"。
  // 注入进来的 store 属于调用方, 由它负责关闭 —— 这里只关自己建的那个。
  const ownsStore = !opts.store;
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
  // 推广服务实例在下方构造 (依赖 reviewDir 与模型); Facade 需要它的"人审提议"出口，
  // 但不需要在构造时就有 —— 用一个持有器打破"组装顺序"这个隐式契约 (const, 只填空一次)。
  const generalizerHolder: { current?: GeneralizerService } = {};
  // 使用层唯一 API: DSH 的工具/召回都经由它, 与 MCP/CLI 共用同一套语义 (ADR-021)。
  const facade = new MemoryFacade(
    { store, retriever },
    // 语义兜底去重默认开启 (本地零依赖哈希袋); 自动演化 (取代/冲突) 由设置控制。
    // 传函数: 面板里改 autoEvolve 当轮生效 (不再需要重启)。
    { embedder: localEmbedder, autoEvolve: () => settings().autoEvolve },
  );
  facade.withIndexStatus(() => store.ftsStatus());
  // 治理出口延后接线 (generalizer 建在下方, 依赖 reviewDir 与模型) ——
  // 坏评超标的记忆据此产出人审提议; 不接线则标注照常落盘, 只是不产生提议。
  facade.withGeneralizer({
    enqueueProposal: (input) => {
      const g = generalizerHolder.current;
      if (!g) throw new Error("hx-memory: generalizer not mounted yet");
      return g.enqueueProposal(input);
    },
  });

  // 注入调度账本 (可观测性真相文件): 每一步的判定都落一条, 含"没注入"的那几种。
  // 保留期按函数传入 —— 面板改设置当轮生效 (与 episode 同一套理由)。
  // 关掉时置 null: 写入路径与面板出口都跟着消失, 但**代码路径不变** (少一个分支就少一处漏判)。
  const scheduleLog = new ScheduleLog({
    root,
    retentionDays: () => (settings().scheduleLog ? settings().scheduleLogRetentionDays : 0),
  });
  // 捕获耗时账本 (与注入调度账本同构): 回答"沉淀有没有把这一轮拖慢、拖在哪一段"。
  // 它与 scheduleLog 是**两条不同的轴** (一个记判定, 一个记耗时), 因此各有各的开关:
  // 只想要其中一个的宿主不该被迫接受另一个的写入成本。
  const captureLog = new CaptureLog({
    root,
    retentionDays: () => (settings().captureLog ? settings().captureRetentionDays : 0),
  });

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
      alwaysOn: (project) => triggerCache.ids(project),
      recallFor: (text, decision, project) => triggerCache.recallFor(text, decision, project),
      now: () => new Date().toISOString(),
      // project 一路透传到这里 (会话的 projectOf → binder.warm → 缓存刷新):
      // 兜底通道此前丢掉了它, 于是 always-on 退化成"不区分项目" —— 泄漏与缓存串味都由此而来。
      warm: (project) => refreshAlwaysOn(project),
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
  // 启动时清一次过期账本 (只跑一次; 与 episode prune 同位置同理由 —— 不需要后台定时器)。
  if (settings().scheduleLog) {
    try {
      const removedSchedule = scheduleLog.prune();
      if (removedSchedule > 0) {
        ctx.logger("hx-memory").info("pruned %d expired schedule records", removedSchedule);
      }
    } catch (error) {
      logWarn("schedule prune failed: %s", error);
    }
  }
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
    // 提供者 (不是实例): 面板里关掉账本当轮生效, 不需要重启。
    captureLog: () => (settings().captureLog ? captureLog : null),
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
  generalizerHolder.current = generalizer;
  const recall = new RecallService((q) => store.query(q), retriever);

  // 后台维护 (P3 的 ⬜ 调度器) 的组装: 策略/执行/记录在 maintenance-wiring.ts。
  // 放在 gateway 之前 —— Service 构造即注册, 它的 maintenance RPC 要读这份记录。
  const maintenance = wireMaintenance({
    ctx,
    root,
    settings,
    idleMs: () => runtime.idleMs(),
  });

  // 挂载 Review Web 服务 (Typert Remote): Service 构造即注册, 随 fiber 自动卸载。
  // bindingStore 必须无条件注入 —— 否则面板 saveBindings 永远返回 "binding store not mounted"。
  ctx.effect(() => {
    const gateway = new HxMemoryGateway(ctx, {
      store,
      generalizer,
      bindingStore,
      invocations: invocationLog,
      facade,
      // 主动整理 (面板 dryRun → 确认 → 写回) 与 CLI 共用同一实现。
      normalizer: { run: (opts) => new MemoryNormalizer(store, root).run(opts) },
      schedule: scheduleLog,
      capture: captureLog,
      // 维护记录与开关同样必须**无条件注入**: 面板据此显示"最近跑过没有/成功没有/为什么关着"。
      // (漏注入的表现是面板上没有维护区块 —— 而这正是本功能要消灭的那类"不可见"。)
      maintenance: maintenance.log,
      maintenanceConfig: () => maintenance.config(),
      // 面板"当前项目"预填: 与捕获/绑定/召回同一派生口径 (仓库级键)。
      currentProject: () => runtime.project(),
    });
    // 装配期校验远端契约 (见 remote-contract.ts): 宿主是**用它自己那份** dsh-typert-protocol
    // 读 @Remote 标记的, 两份实例不等价时全部端点会静默 404, 而 fiber 依旧 active。
    // 在这里失败比让面板收到 19 个 404 强 —— 加载错误能一眼看见, 静默 404 不能。
    assertRemoteContract(remoteContract(gateway, HXMEM_REMOTE_METHODS));
    return () => void 0; // Service 随 fiber 自动卸载, 无需手动清理
  }, "hx-memory.gateway()");

  // 设置: 宿主提供 installSection 时把用户层接进来 (必须接住 setSource 的权威 thunk,
  // 否则用户改的设置永远不会被读到); 旧宿主没有这个方法就退回组合配置。
  // 宿主版本差异的处理整段在 settings-wiring.ts (组装根只负责调用)。
  wireSettings({ ctx, compositionSettings, settingsSource });

  // 工具注册
  ctx.effect(
    () => registerMemoryTools(ctx, { store, generalizer, retriever, facade }),
    "hx-memory.tools()",
  );

  // 生命周期 (预热 + 卸载清理)。卸载顺序与 HMR 幂等的理由写在 lifecycle-wiring.ts。
  wireLifecycle({
    ctx,
    warmUp: () => pipe.warmUp(),
    warmSync: () => retriever.warmSync(),
    loop: maintenance.loop,
    flushAll: () => runtime.flushAll(),
    store,
    ownsStore,
  });

  // 会话开始: 注入记忆指引 + 跨项目规则召回 (只注入规则, 不注入历史)。
  // 判定与组装在 session-start.ts (组装根只负责把它接上事件)。
  const onSessionStart = makeSessionStartHandler({
    binder,
    recall,
    settings: () => ({
      rootAgentsOnly: settings().rootAgentsOnly,
      injectGuidance: settings().injectGuidance,
      language: settings().language,
    }),
    projectOf: (session) => projectOfSession(session) ?? session.id,
  });
  ctx.on("agent/session-start", (payload: unknown) => {
    // 会话状态登记与注入分开: 即使不注入 (subagent/关掉指引), runtime 也要开始跟踪这一会话。
    const agent = (payload as { agent: { session: SessionLike } }).agent;
    runtime.onSessionStart(agent.session);
    onSessionStart(payload);
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
      injectMode: () => settings().injectMode,
      projectOf: (payload) => projectOfSession(payload.agent.session) ?? payload.agent.session.id,
      // 判定落账: 写入永远 best-effort (append 不抛), 账本关掉时直接丢弃。
      onDecision: (decision) => {
        if (!settings().scheduleLog) return;
        scheduleLog.append({ at: new Date().toISOString(), ...decision });
      },
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
