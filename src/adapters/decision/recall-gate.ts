// src/adapters/decision/recall-gate.ts — 召回闸: 用判官回答"这一轮该不该召回记忆"。
//
// ## 为什么需要它 (2026-09-29, 真人实测暴露的真问题)
//
// 用户收到的注入是 9 条跨项目工程规则, 而他问的是"兼容 dsh 新版本" —— **一条都不相关**。
// 根因: always-on 保底通道**不看输入意图** (它按 kind/importance 排序, 无条件注入),
// 而意图通道只认**正则句式** ("上次怎么处理" / "为什么当初这么定"), 认不出
// "这个会和输入意图有关吗" 这类因果追问。实测该会话全部判定的 `intent=None`。
//
// 结论: 判"这句话是否与候选记忆相关"是**语义判断**, 不是正则能覆盖的 —— 而这正是决策端口
// 擅长的窄判定。判官单次 ~0.5s、成本极低, 输出稳定的原子判定, 与"每轮都跑"的形态匹配。
//
// ## 判据设计: **只判"是否召回", 不问"召回哪几条"** (用户 2026-09-29 选定)
//
// 两个理由:
//   1. **延迟**: "哪几条"需要把候选全列进 state (候选多时 state 爆炸, 且判官是每轮同步路径);
//      "是否"只需给候选的**摘要**, 输入量恒定。
//   2. **判官的能力边界**: 它是概率模型, 输出"原子判定"。让它从 20 条里挑 3 条,
//      等于要它做生成/排序 —— 那是通用模型的活 (PORT.md 的实测对比)。
// 因此本层只回答 yes/no; 具体选哪几条仍由既有的确定性排序 (分数 + 预算 + 条数闸) 决定。
//
// ## 不可用就换: 三层降级 (与用户要求"失败 n 次就不显示"对齐)
//
//   1. 判官**报错/不存在** → 走既有通道 (计一次失败; 连续 n 次即熔断 —— 用户选定"两种都算");
//   2. 判官**没把握** (一致度/锐度低) → 走既有通道, 同样计数;
//   3. **熔断中** → 连判官都不调, 直接走既有通道 (省掉 0.5s) —— 这就是"失败 n 次就不显示"。
//
// **关键**: 任何一层降级都**不会**变成"记忆失效" —— 降级目标是**既有的保底 + 意图通道**,
// 而不是"什么都不注入" (用户 2026-09-29 明确选定)。这条是本仓 r00155cdb954e41c7 的落实:
// 保底通道不得依赖模型自觉, 同样也不得依赖判官可用。实测若改成"判官失灵即不注入",
// 后果是记忆整体静默消失 (本仓实测主动检索率仅 6.7%, 即模型不会自己补上那一次查询)。
//
// ## 判官只能收紧, 不能放宽
//
// 返回的是**建议抑制** (`suppress: true` 才改变行为), 而不是"应当召回"。判官说"不相关"
// 时我们跟着收紧; 判官说"相关"时**不额外放宽** (仍是既有行为)。于是判官失灵的最坏后果是
// "按老行为走", 而不是"多注入一堆噪声" —— 这条在判官是概率模型的前提下是必须的
// (PORT.md 纪律 2: 一致性 != 正确性, 高一致度不等于可信)。

import type {
  DecisionDoctorReport,
  DecisionOutcome,
  DecisionPort,
  DecisionQuestion,
} from "../../kernel/ports-decision.ts";
import { FallbackController, type RoutePolicy } from "./fallback.ts";
import type { DecisionLog } from "./decision-log.ts";

/** 判定用途 (写进账本; 一个账本里有多种判定, 必须能切开看)。 */
export const RECALL_GATE_PURPOSE = "recall-gate";

/** 召回闸的建议。 */
export interface RecallGateSuggestion {
  /**
   * 是否建议**抑制**这一轮的召回 (判官说"候选与当前输入无关")。
   *
   * 语义刻意是"抑制"而不是"应当召回": 默认不抑制 (保守)。
   * 判官说不相关 → 我们跟着收紧; 判官说相关 → **不额外放宽** (仍是既有行为)。
   * 这样判官失灵时的最坏后果是"按老行为走", 不是"多注入一堆噪声"。
   */
  suppress: boolean;
  /** 判官是否真的给了意见 (false = 降级/熔断/报错, 调用方应走既有路径)。 */
  consulted: boolean;
  /** 可解释的结论 (进日志与面板)。 */
  reason: string;
  /** 判定耗时 (ms)。 */
  elapsedMs: number;
}

export interface RecallGateDeps {
  /** 判定实现 (可选: 不传 = 永远降级, 行为与"没有判官"完全一致)。 */
  port?: DecisionPort;
  /** 回退控制器 (可选: 不传则新建一个内存态实例)。 */
  fallback?: FallbackController;
  /** 决策账本 (可选: 不传则不落盘 —— 但那就失去了"熔断为什么发生"的证据)。 */
  log?: DecisionLog;
  /** 策略覆盖。 */
  policy?: Partial<RoutePolicy>;
  /** 采样次数 (缺省按实现自报的 needsVoting 决定)。 */
  samples?: number;
  /** 现在 (可注入, 便于测试)。 */
  now?: () => number;
}

/**
 * 召回闸。**一个实例服务一个进程** (回退状态是进程级的统计, 不应按会话分裂)。
 */
export class RecallGate {
  private readonly port?: DecisionPort;
  private readonly fallback: FallbackController;
  private readonly log?: DecisionLog;
  private readonly samples?: number;
  private readonly now: () => number;
  /**
   * 启动期探测的结论 (`probe()` 后才有值)。
   *
   * `missing-config` 与 `error` 要分开: 前者是**配置缺失** (没 key / 目录不存在), 判官在
   * 修好之前**永远不会**成功 —— 每轮都调它只是白花 0.5s, 因此直接跳过调用 (仍走既有通道)。
   * 后者是**调用层故障** (超时/上游 500), 它可能自愈, 因此交给回退控制器按 n 次统计。
   */
  private probeVerdict: "unknown" | "ok" | "missing-config" | "error" = "unknown";
  private probeError = "";

  constructor(deps: RecallGateDeps = {}) {
    this.port = deps.port;
    this.fallback = deps.fallback ?? new FallbackController({ policy: deps.policy });
    this.log = deps.log;
    this.samples = deps.samples;
    this.now = deps.now ?? (() => Date.now());
  }

  /** 当前回退状态 (供观测面: "熔断了但没人知道"是最坏情况)。 */
  status(): ReturnType<FallbackController["status"]> {
    return this.fallback.status();
  }

  /** 手动复位熔断 (用户发现"判官现在对了"时)。 */
  reset(): void {
    this.fallback.reset();
    // 复位熔断也顺带重开探测: 用户手动说"现在对了"时, 配置多半也一起修好了。
    this.probeVerdict = "unknown";
    this.probeError = "";
  }

  /**
   * 启动期可用性探测 (**可用性**是用户点名的要求之一)。
   *
   * 为什么要它而不是只靠熔断: "不可用"有两种形态, 处置不同 ——
   *   · **配置缺失** (没有 key / 决策目录不存在): 在修好之前永远不会成功。
   *     靠熔断要白花 n 次 × 0.5s 才发现, 而它是**已知的、可预检的**;
   *   · **调用层故障** (超时/上游 500): 可能自愈, 不该一探不通就永久停用。
   * 因此这里把 `missing-config` 标成"跳过调用", 把 `error` 留给回退控制器统计。
   *
   * 实现不提供 `doctor()` 时视为"无法预检" (不阻塞) —— 这是契约允许的可选能力。
   *
   * @returns 探测报告; 无实现/无自检能力时返回 null。
   */
  async probe(): Promise<DecisionDoctorReport | null> {
    if (!this.port) {
      this.probeVerdict = "missing-config";
      this.probeError = "未配置判定实现";
      return null;
    }
    if (typeof this.port.doctor !== "function") {
      this.probeVerdict = "ok"; // 无自检能力, 不阻塞 (但它也没证明自己可用)
      return null;
    }
    let report: DecisionDoctorReport;
    try {
      report = await this.port.doctor();
    } catch (error) {
      this.probeVerdict = "error";
      this.probeError = String(error);
      this.write({ purpose: RECALL_GATE_PURPOSE, adapter: this.port.name, outcome: "error", reason: "doctor 抛错: " + this.probeError });
      return null;
    }
    if (report.ok) {
      this.probeVerdict = "ok";
      return report;
    }
    const reason = String(report.error ?? "unknown");
    // `no_key` / 目录缺失 = 配置缺失 (可预检且不会自愈) ⇒ 跳过调用。
    const isConfig = /no_key|missing|not_found|ENOENT/i.test(reason);
    this.probeVerdict = isConfig ? "missing-config" : "error";
    this.probeError = reason;
    this.write({
      purpose: RECALL_GATE_PURPOSE,
      adapter: this.port.name,
      outcome: "error",
      reason: (isConfig ? "配置缺失" : "调用层故障") + ": " + reason,
    });
    return report;
  }

  /** 探测结论 (供观测面/面板显示"判官为什么没在工作")。 */
  probeStatus(): { verdict: string; error: string } {
    return { verdict: this.probeVerdict, error: this.probeError };
  }

  /**
   * 判"这一轮该不该抑制召回"。
   *
   * @param userText 当前轮用户输入 (原文; 判官做语义判断, 不做字面匹配)。
   * @param candidates 候选记忆的**摘要** (不是全文: state 要短才有低延迟)。
   * @returns 建议 + 是否真的咨询过判官 + 原因。
   */
  async judge(userText: string, candidates: { count: number; sample: readonly string[] }): Promise<RecallGateSuggestion> {
    const elapsed = (from: number): number => this.now() - from;
    const started = this.now();
    const base = { suppress: false, consulted: false, elapsedMs: 0 } as const;

    // 没有判官实现: 完全等同"没有这层" (既有行为一字不变)。
    if (!this.port) {
      this.write({ purpose: RECALL_GATE_PURPOSE, adapter: "none", outcome: "upgraded", reason: "未配置判定实现 (降级为既有行为)" });
      return { ...base, elapsedMs: elapsed(started), reason: "未配置判定实现" };
    }
    // 空输入或没有候选: 没有可判的东西 —— 不浪费一次判官调用。
    if (!userText.trim() || candidates.count === 0) {
      return { ...base, elapsedMs: elapsed(started), reason: "无可判内容 (空输入或无候选)" };
    }

    // ── 配置缺失 (探测已确认, 在修好前永远不会成功): 跳过调用, 连 0.5s 都不花 ──
    if (this.probeVerdict === "missing-config") {
      return {
        ...base,
        elapsedMs: elapsed(started),
        reason: "判官配置缺失, 已跳过 (走既有通道): " + this.probeError,
      };
    }

    // ── 熔断中: 连判官都不调 (这就是"失败 n 次就不显示") ──────────────────────
    if (this.fallback.circuitOpen()) {
      const st = this.fallback.status();
      this.write({
        purpose: RECALL_GATE_PURPOSE,
        adapter: this.port.name,
        outcome: "circuit",
        reason: "熔断冷却中: 直接走既有判定 (连判官都不调)",
        circuitTrips: st.circuitTrips,
        elapsedMs: elapsed(started),
      });
      return { ...base, elapsedMs: elapsed(started), reason: "熔断冷却中 (判官连续没把握, 已停用)" };
    }

    const outcome = await this.ask(userText, candidates);
    // ⚠ 顺序是**有意的**: 路由在前、判空结果在后 —— 于是"判官报错"与"判官没把握"
    // **两种失败都会计入回退控制器**, 连续 n 次即熔断 (用户 2026-09-29 选定: "两种都算")。
    // 为什么报错也要算: 上游 500 或超时会让每一轮都白花一次 0.5s 的无效开销,
    // 而"报了错还每轮继续试"正是要停止的行为。判据是"这次没拿到可信结果", 不是"谁的错"。
    // (账本仍把两者分开记 `error` / `circuit` / `upgraded` —— 熔断口径统一, 但追因要能区分。)
    const route = this.fallback.route(outcome);

    // ── 判官调用层失败 (脚本缺失/超时/非 JSON): 降级为既有行为 ──────────────
    if (!outcome.ok) {
      this.write({
        purpose: RECALL_GATE_PURPOSE,
        adapter: this.port.name,
        outcome: "error",
        reason: outcome.error,
        circuitTrips: this.fallback.status().circuitTrips,
        elapsedMs: elapsed(started),
      });
      return { ...base, elapsedMs: elapsed(started), reason: "判官不可用: " + outcome.error };
    }

    if (!route.usePrimary) {
      this.write({
        purpose: RECALL_GATE_PURPOSE,
        adapter: this.port.name,
        outcome: route.circuitOpen ? "circuit" : "upgraded",
        agreement: outcome.agreement,
        ...(typeof outcome.sharpness === "number" ? { sharpness: outcome.sharpness } : {}),
        reason: route.reason,
        circuitTrips: this.fallback.status().circuitTrips,
        elapsedMs: elapsed(started),
      });
      return { ...base, elapsedMs: elapsed(started), reason: route.reason };
    }

    const answer = outcome.answers["recall"];
    const saidNo = answer?.choice === "no";
    this.write({
      purpose: RECALL_GATE_PURPOSE,
      adapter: this.port.name,
      outcome: "used",
      agreement: outcome.agreement,
      ...(typeof outcome.sharpness === "number" ? { sharpness: outcome.sharpness } : {}),
      ...(answer?.choice ? { choice: answer.choice } : {}),
      reason: saidNo ? "判官判定候选与当前输入无关" : "判官判定候选相关 (不额外放宽, 保持既有行为)",
      elapsedMs: elapsed(started),
    });
    return {
      suppress: saidNo,
      consulted: true,
      elapsedMs: elapsed(started),
      reason: saidNo ? "判官判定无关 → 抑制本轮召回" : "判官判定相关 → 保持既有行为",
    };
  }

  /** 真正调判官 (单问题; 采样按实现自报的 needsVoting 定)。 */
  private async ask(
    userText: string,
    candidates: { count: number; sample: readonly string[] },
  ): Promise<DecisionOutcome> {
    const caps = this.port!.capabilities();
    const samples = this.samples ?? (caps.needsVoting ? 7 : 1);
    // state 给**症状与事实**, 不给结论 (PORT.md 硬纪律 1: 写结论会让判定反转)。
    const state = [
      "场景: agent 每轮会往上下文注入一批长期记忆 (跨项目工程规则/经验)。",
      `当前用户输入: ${userText.slice(0, 800)}`,
      `候选记忆共 ${candidates.count} 条, 其中前几条的内容:`,
      ...candidates.sample.slice(0, 5).map((s, i) => `  ${i + 1}. ${String(s).slice(0, 160)}`),
    ].join("\n");
    const questions: DecisionQuestion[] = [
      {
        qid: "recall",
        type: "choice",
        instructions:
          "这批候选记忆与当前用户输入是否相关 —— 相关到值得把它们注入上下文?" +
          "若用户输入与候选内容讲的是不同的事, 选 no。",
        criteria: { yes: "相关, 值得注入", no: "不相关, 注入只是占用上下文的噪声" },
      },
    ];
    return await this.port!.decide(state, questions, samples);
  }

  /** 落账 (best-effort: 不传 log 时是 no-op)。 */
  private write(record: Parameters<DecisionLog["append"]>[0]): void {
    this.log?.append(record);
  }
}
