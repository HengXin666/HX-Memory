// src/adapters/dsh/index.ts — HX-Memory 的 DSH (cordis) 插件入口。
// 接线:
//   agent/session-start → 注入记忆指引 (只指引不注入历史)
//   agent/pre-step      → 声明式绑定确定性注入 (见 prestep.ts)
//   session/event       → 聚合 turn → 批量捕获入记忆 (见 runtime.ts)
//   ctx.tools.register  → memory_search / memory_save / memory_rule_propose
//   ctx.settings        → 可配置开关 (经 installSection 接住宿主权威配置源)
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-settings";
import { FileBackend } from "../../storage/file-store.js";
import { CapturePipeline } from "../../capture/pipeline.js";
import { createPendingGuidance, makeSessionStartHandler } from "./session-start.js";
import { makeRegistrationCheck, wireSessionLifecycle } from "./session-wiring.js";
import { wirePrestepAndCapture } from "./prestep-wiring.js";
import { HxMemoryRuntime, scopeOfSession } from "./runtime.js";
import type { ProjectScopeArg } from "../../kernel/project-lineage.ts";
import { registerMemoryTools } from "./tools.js";
import { captureReviewBridge } from "./capture-review-bridge.ts";
import { makeAlwaysOnDetailedReader } from "./gateway-injection.ts";
import { EpisodeStore } from "../../storage/episode-store.js";
import { GeneralizerService } from "../../generalize/service.ts";
import { makeLlmAbstractor } from "./llm-abstractor.js";
import { makeLlmStructurer } from "./llm-structurer.js";
import { HybridRetriever } from "../../retrieval/hybrid.js";
import { MemoryFacade } from "../../app/facade.js";
import { MemoryNormalizer } from "../../app/normalize.ts";
import { LexicalEmbedder } from "../../retrieval/embedding-lexical.js";
import { LinearVectorIndex } from "../../retrieval/vector.js";
import { ProjectedVectorIndex } from "../../retrieval/vector-projected.js";
import { openAiEmbedderFromEnv } from "../../retrieval/embedding-http.js";
import { Binder } from "../../kernel/binder.ts";
import { BindingStore } from "../../bindings/store.ts";
import { mountGateway } from "./gateway-mount.ts";
import { InvocationLog } from "./invocations.js";
import type { LlmInvocationRecord } from "./llm-agent.js";
import { createLiveSettings } from "./settings-live.js";
// 设置 schema 必须由**本入口**再导出一次 (0.1.7+ 契约): 宿主从
// `entry.fiber.runtime.Config` 读它 (`cordis` 的 `plugin()` 取的就是 `plugin.Config`),
// 而那正是这个模块的导出面。少了这一行, 宿主判定"该条目没有 schema" → 设置页上
// 整个命名空间消失, 且**没有任何报错** (2026-09-29 实测)。
export { Config, MEMORY_SETTINGS_NAMESPACE, MEMORY_SETTING_KEYS } from "./settings.js";
import { createTriggerCache } from "./trigger-cache.js";
import { ScheduleLog } from "./schedule-log.js";
import { CaptureLog } from "./capture-log.js";
import { wireMaintenance } from "./maintenance-wiring.js";
import { wireSettings } from "./settings-wiring.js";
import { wireLifecycle } from "./lifecycle-wiring.js";
import { wireDecisionGate } from "./decision-wiring.js";

export const name = "hx-memory";
// 只硬依赖工具注册表: 事件监听不需要服务, 设置经 ctx.inject 可选接入,
// llm/agentDefaultModel 用 ctx.get 探测 (缺失时 AI 增强自动回退启发式, 插件照常工作)。
export const inject = ["tools"];

// 入口选项与默认路径整段在 plugin-options.ts; 这里再导出, 保持既有导入路径不变。
export type { HxMemoryPluginOptions } from "./plugin-options.js";
export { defaultMemoryRoot } from "./plugin-options.js";
// 上面两行只做再导出 (不引入本地绑定), 但本模块自己要使用它们 —— 因此仍需本地导入。
import { defaultMemoryRoot, type HxMemoryPluginOptions } from "./plugin-options.js";

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
  // 组合配置 (插件 entry) 是 base; 0.1.7+ 由 volatile 引用覆盖, 旧宿主由 wireSettings 接 thunk。
  // 三步的顺序是硬约束 (写错的表现是"设置看着生效、其实读默认值"且无报错), 因此收在
  // createLiveSettings 里由结构保证 —— 见 settings-live.ts 的说明。
  const liveSettings = createLiveSettings(opts.settings ?? {}, opts);
  const settingsSource = liveSettings.source;
  const settings = liveSettings.read;

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
  // 证据链: 条目 → 原文 (与 app/stack.ts 同一接线, 保证各宿主行为一致)。
  facade.withEvidence(new EpisodeStore({ root, retentionDays: settings().episodeRetentionDays }));
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
    // 条数上限: 传**函数** —— 面板改动当轮生效 (与 autoEvolve/episodeRetentionDays 同一约定)。
    // 缓存已把条数纳入失效判据 (见 trigger-cache 的 caches), 因此改条数不会命中旧缓存。
    maxEntries: () => settings().alwaysOnMaxEntries,
  });
  const refreshAlwaysOn = (scope?: ProjectScopeArg): Promise<void> => triggerCache.refresh(scope);

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
      alwaysOn: (scope) => triggerCache.ids(scope),
      recallFor: (text, decision, scope) => triggerCache.recallFor(text, decision, scope),
      now: () => new Date().toISOString(),
      // 工作区范围一路透传到这里 (会话的 scopeOf → binder.warm → 缓存刷新):
      // 兜底通道此前丢掉了它, 于是 always-on 退化成"不区分项目" —— 泄漏与缓存串味都由此而来。
      warm: (scope) => refreshAlwaysOn(scope),
      // 命中即强化: 确定性注入是每轮都在跑的主通道, 注入过的记忆必须算"被用到"。
      // Facade.reinforce 自带 60s 合并窗口 (同窗口内重复命中只写一次), 失败静默 (不拖垮注入)。
      onInjected: (ids) => {
        if (ids.length) void facade.reinforce(ids).catch(() => undefined);
      },
    },
  );
  // AI 结构化: 经 agents 服务调最小 agent; 不可用时 pipeline 自动回退启发式。
  const structurer = safeAgent(() => makeLlmStructurer(ctx, settings));
  // reviewRoot 与真相文件同根: 待审队列要落在人能找的地方 (而不是临时目录)。
  const pipe = new CapturePipeline(store, {
    structurer: structurer ?? undefined,
    reviewRoot: root,
  });

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
    // 负面/纠正信号判定面 (词表可配置 ⇒ 必须每次求值, 不能构造期固化)。
    negativity: () => gate.negativity.capture,
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
  // 待发指引: 会话开始装入、首轮预步取走后清空 —— 记忆**只有 pre-step 一个注入点**。
  const pendingGuidance = createPendingGuidance();

  // 后台维护 (P3 的 ⬜ 调度器) 的组装: 策略/执行/记录在 maintenance-wiring.ts。
  // 放在 gateway 之前 —— Service 构造即注册, 它的 maintenance RPC 要读这份记录。
  const maintenance = wireMaintenance({
    ctx,
    root,
    settings,
    idleMs: () => runtime.idleMs(),
  });

  // 面板网关的装配整段在 gateway-mount.ts (组装根只负责传依赖 + root)。
  mountGateway({
    ctx,
    root,
    deps: {
      store,
      generalizer,
      bindingStore,
      invocations: invocationLog,
      facade,
      // 主动整理 (面板 dryRun → 确认 → 写回) 与 CLI 共用同一实现。
      normalizer: { run: (opts: Parameters<MemoryNormalizer["run"]>[0]) => new MemoryNormalizer(store, root).run(opts) },
      // 待审队列: 从磁盘现读 (队列是追加写的真相文件, 不做缓存 —— 面板刷新要看到最新)。
      captureReview: captureReviewBridge(root),
      alwaysOnDetailed: makeAlwaysOnDetailedReader(() => Promise.resolve(store.all())),
      schedule: scheduleLog,
      capture: captureLog,
      // 维护记录与开关同样必须**无条件注入**: 面板据此显示"最近跑过没有/成功没有/为什么关着"。
      maintenance: maintenance.log,
      maintenanceConfig: () => maintenance.config(),
      // 面板"当前项目"预填: 与捕获/绑定/召回同一派生口径 (仓库级键)。
      currentProject: () => runtime.project(),
    },
  });
  // 旧宿主 (<= 0.1.6) 的 installSection 把"权威配置 thunk"交给消费方 —— 必须接住,
  // 否则用户改的设置永远不会被读到。0.1.7+ 已在 createLiveSettings 里由 volatile 引用接管,
  // 这里只负责"别让宿主再为它自动生成一份页面"。
  // 宿主版本差异的处理整段在 settings-wiring.ts (组装根只负责调用)。
  wireSettings({
    ctx,
    // 必须是**补全过默认值**的组合层 (旧宿主 0.1.1 的 register 拿它当 base, 传裸
    // opts.settings 会让宿主侧大部分字段是 undefined —— 见 LiveSettings.composition)。
    compositionSettings: liveSettings.composition,
    settingsSource,
  });

  // 决策层 (召回闸) + 负面/纠正信号链路: 两者的接线整段在 decision-wiring.ts。
  const gate = wireDecisionGate({
    root,
    settings,
    logWarn,
    // 以往同类纠正: 用使用层检索 (`purpose:"recall"` 只按相关性排, 不占保底通道)。
    recallLessons: async (text) => {
      const scope = runtime.scope();
      const ranged = {
        ...(scope?.project ? { project: scope.project } : {}),
        ...(scope?.lineage?.length ? { lineage: scope.lineage } : {}),
      };
      const hits = facade.recall({
        text: text + " 禁止 改为 教训 被否决",
        purpose: "recall",
        limit: 3,
        tokenBudget: 260,
        ...(Object.keys(ranged).length ? { scope: ranged } : {}),
      }).hits;
      return hits.map((h) => h.entry.content.slice(0, 120));
    },
  });

  // 工具注册
  ctx.effect(
    () =>
      registerMemoryTools(ctx, {
        store,
        generalizer,
        retriever,
        facade,
        // 主动写记忆的真实来源 (取代常量 "session:tool"): 与捕获路径同一口径。
        sourceOf: () => runtime.sessionId(),
        // memory_search 的项目过滤范围 (与 trigger-cache 的 recallFor 同一口径)。
        // 不给它就会搜全库 ⇒ 别的项目的私有记忆被当本项目经验 (见 MemoryToolDeps.scopeOf)。
        scopeOf: () => runtime.scope(),
      }),
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

  // 会话开始: **只登记, 不注入** (指引装入待发容器, 由首轮预步随记忆块发出)。
  // 判定在 session-start.ts (组装根只负责把它接上事件)。
  const onSessionStart = makeSessionStartHandler({
    settings: () => ({
      rootAgentsOnly: settings().rootAgentsOnly,
      injectGuidance: settings().injectGuidance,
      language: settings().language,
    }),
    pending: pendingGuidance,
  });
  // 会话生命周期接线 (会话开始的双事件名 + 离开时的冲刷) 整段在 session-wiring.ts。
  // 那一段独立成文件的原因不只是行数: 它承载的是一次真实故障的修法 (见该文件头注)。
  wireSessionLifecycle({
    ctx,
    runtime,
    onSessionStart,
    pendingGuidance,
    warn: (message) => logWarn(message, ""),
  });

  // 逐轮确定性注入 + 捕获。两段接线整段在 prestep-wiring.ts:
  // 前者是"每步注入什么", 后者是"每一轮沉淀什么" —— 它们共享一个**上下文来源**
  // (会话的 scope), 而那正是本次 dsh 0.2.0 故障打断的东西 (见 session-wiring.ts 头注)。
  wirePrestepAndCapture({
    ctx,
    binder,
    runtime,
    pendingGuidance,
    scheduleLog,
    settings,
    scopeOf: scopeOfSession,
    logWarn,
    negativity: gate.negativity,
    checkRegistration: makeRegistrationCheck(runtime, (m) => logWarn(m, "")),
  });
}

export type { HxMemorySettings } from "./types.js";
