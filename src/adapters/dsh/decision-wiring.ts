// src/adapters/dsh/decision-wiring.ts — 决策端口到宿主的接线 (组装根只调一行)。
//
// ## 为什么这段必须独立成文件
//
// 1. 组装根 (index.ts) 有 400 行硬上限, 而"决策层怎么接、按什么判据接"是天然独立的职责;
// 2. 更要紧的是**接线判据必须集中一处**: 决策层有三层降级 (实现缺失 / 配置缺失 / 熔断),
//    散进业务代码就会各处判一遍, 且必然分叉。
//
// ## 为什么默认**不启用** (2026-09-29, 用户"先做地基")
//
// 本层是地基: 端口契约 + 回退 + 账本都已完成并实测通过, 但**尚未接入注入路径** ——
// 用户明确要求"先做地基", 而把判官接进每轮注入会引入一次 0.5s 的同步开销, 那属于下一步决策。
// 因此默认 `enabled: false`: 代码路径真实可达 (不是悬空模块), 但行为与接入前**逐字一致**。
//
// ⚠ **这个"默认关"是可观测的, 不是静默的**: 关闭时 `wireDecision` 返回的 status 里
// `reason` 会写明"未启用", 而账本/面板能读到它 —— 避免变成"机制在、没人知道它没开"。
//
// 为什么不是"直接不写接线" (也就是让它悬空): 本仓的门禁专门查这个
// (`verify-structure` 的悬空模块检查) —— `src/wiki/` 曾 1014 行产品代码零引用,
// 而发现它靠的是人工 grep。悬空的代码不是"还没做", 是"做了但没人知道它没接上"。
import type { DecisionPort } from "../../kernel/ports-decision.ts";
import { DecisionLog } from "../decision/decision-log.ts";
import { FallbackController } from "../decision/fallback.ts";
import { JevDecisionAdapter } from "../decision/jev-adapter.ts";
import { RecallGate } from "../decision/recall-gate.ts";
import { wireNegativity, type NegativityWiring } from "./negativity-wiring.js";
import type { HxMemorySettings } from "./types.js";

/** 接线结果 (给组装根与观测面)。 */
export interface DecisionWiring {
  /** 召回闸 (未启用时为 undefined —— 调用方用 `?.` 探测, 与"没有这层"同一形态)。 */
  gate?: RecallGate;
  /** 判定实现 (未启用/不可用时为 undefined)。 */
  port?: DecisionPort;
  /** 账本 (未启用时也为 undefined: 没启用就没有判定要记)。 */
  log?: DecisionLog;
  /** 为什么是这个状态 (可解释; 面板/日志据此回答"判官为什么没在工作")。 */
  reason: string;
  /** 是否真的启用了判定路径。 */
  enabled: boolean;
}

/** 统一接线的入参 (组装根只给这三样)。 */
export interface DecisionGateDeps {
  /** 记忆根 (账本/熔断状态都落在它下面)。 */
  root: string;
  /** 设置读取器 (每次求值)。 */
  settings: () => HxMemorySettings;
  /** 旁路告警 (best-effort)。 */
  logWarn: (message: string, error: unknown) => void;
  /**
   * 查"以往同类纠正" (可选)。
   * 由组装根注入 Facade 的检索面 —— 本模块不该依赖 Facade (它只是接线)。
   */
  recallLessons?: (text: string) => Promise<readonly string[]>;
}

/** 统一接线的结果。 */
export interface DecisionGate {
  decision: DecisionWiring;
  negativity: NegativityWiring;
}

export interface DecisionWiringDeps {
  /** 记忆根目录 (账本落在 <root>/decision-log; 熔断状态落在 <root>/decision)。 */
  root: string;
  /**
   * 设置读取器 (每次求值, 面板改动当轮生效)。
   *
   * 为什么不直接收 `enabled: boolean`: 组装根去读设置会把"哪个设置开哪一层"的知识
   * 留在组装根, 而那正是本模块要收口的东西 (见文件头注的接线判据集中一处)。
   */
  /**
   * 设置读取器 (每次求值, 面板改动当轮生效)。**收全量设置**, 由本模块自己窄化出它要的两个键 ——
   * 让组装根不必知道"决策层关心哪些设置"(那是本层的事)。
   */
  readSettings?: () => { decisionGate: boolean; decisionRetentionDays: number };
  /**
   * 是否启用 (显式传参优先于 `settings`; 测试用)。**默认 false**。
   * 真值时才开始构造适配器并探测可用性。
   */
  enabled?: boolean;
  /** 决策脚本目录 (覆盖 `HX_DECISION_DIR`)。 */
  decisionDir?: string;
  /** 采样次数 (缺省按实现自报的 needsVoting 决定)。 */
  samples?: number;
  /** 注入一个现成实现 (测试/换实现用; 给了就不再构造 JEV)。 */
  port?: DecisionPort;
  /** 保留天数 (账本; 显式传参优先于 `settings`)。 */
  retentionDays?: number | (() => number);
}

/**
 * 装配决策层。
 *
 * 判据是**能力探测**而不是版本号或配置存在性:
 *   · 未启用 → 连适配器都不构造 (零开销);
 *   · 启用了但脚本目录不在 → 仍然构造 (让 `probe()` 能如实报告"配置缺失"),
 *     并把结论写进账本 —— 用户据此知道"我开了但它起不来", 而不是看到行为没变却不知为何。
 */
export function wireDecision(deps: DecisionWiringDeps): DecisionWiring {
  // 启用判据: 显式传参 > 设置项 > 环境变量 (后者供无面板的场景临时打开)。
  const snapshot = deps.readSettings?.();
  const settingsView = snapshot
    ? { enabled: snapshot.decisionGate, retentionDays: snapshot.decisionRetentionDays }
    : undefined;
  const enabled =
    deps.enabled ?? settingsView?.enabled ?? process.env.HX_MEMORY_DECISION_GATE === "1";
  if (!enabled) {
    return { reason: "决策层未启用 (地基已就绪, 待接入注入路径)", enabled: false };
  }
  const retention = deps.retentionDays ?? (() => settingsView?.retentionDays ?? 7);
  const log = new DecisionLog({ root: deps.root, retentionDays: retention });
  // 熔断状态放在 <root>/decision (与账本目录分开: 前者是状态, 后者是证据)。
  const fallback = new FallbackController({
    persistAs: "recall-gate",
    stateDir: deps.root + "/decision",
  });
  const port = deps.port ?? new JevDecisionAdapter({
    ...(deps.decisionDir ? { decisionDir: deps.decisionDir } : {}),
  });
  const gate = new RecallGate({
    port,
    fallback,
    log,
    ...(deps.samples === undefined ? {} : { samples: deps.samples }),
  });
  return {
    gate,
    port,
    log,
    enabled: true,
    reason: `决策层已启用 (实现: ${port.name}, 可用性待 probe 确认)`,
  };
}

/**
 * 决策层 + 负面/纠正信号链路的**统一接线** (组装根只调这一行)。
 *
 * 为什么把两者收在一处: 它们共用同一个判官实现 (JEV) 与同一个决策账本 —— 各自 new 一份
 * 会出现"两个熔断器互不知道对方在失灵"(实测踩过同类: 两处各判一遍必然分叉)。
 * 而它们的**开关仍然独立**: "注入前要不要判相关性" (decisionGate) 与
 * "被骂了要不要判语义" (negativityJudge) 是两个互不相干的取舍, 合并开关会让用户
 * 为了其中一个去接受另一个的开销。
 */
export function wireDecisionGate(deps: DecisionGateDeps): DecisionGate {
  // 召回闸 (可能未启用 —— 那条路径的判据与理由整段在 wireDecision)。
  const decision = wireDecision({ root: deps.root, readSettings: deps.settings });
  // 负面/纠正信号链路: 词表来自设置 (可配置), 判官复用决策层那一个实例。
  const negativity = wireNegativity({
    words: () => deps.settings().negativityWords ?? "",
    judgeEnabled: () => deps.settings().negativityJudge !== false,
    port:
      decision.port ??
      new JevDecisionAdapter({
        ...(process.env.HX_DECISION_DIR ? { decisionDir: process.env.HX_DECISION_DIR } : {}),
      }),
    ...(decision.log ? { log: decision.log } : {}),
    ...(deps.recallLessons ? { recallLessons: deps.recallLessons } : {}),
  });
  // 会话登记失效的运行时告警 (见 session-wiring.ts 的头注): 这里只把消息打到宿主日志。
  void deps.logWarn;
  return { decision, negativity };
}
