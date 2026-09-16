// src/adapters/dsh/schedule-log.ts — 注入调度账本 (触发层"为什么"的落盘端)。
//
// 为什么需要它 (真实缺口): trigger/policy.ts 的头注释写着"每次决策都给出 reason/confidence/budget,
// 落进触发日志 —— '为什么没注入' 必须和 '注入了什么' 一样可查"。但 TriggerDecision 此前只活在
// Binder 的私有字段里: 全仓没有任何读取方, 也没有落盘。于是"这一轮为什么注入了/为什么没注入"
// 用户和维护者都看不见, 只能读源码猜 —— 设计目标写了一年, 实现没兑现。
//
// 三个形态取舍 (都不是随手选的):
//   1. **JSONL 追加日志**, 与 episodes 同构: 一天一个文件, 一行一条。人能 tail, 机器能解析,
//      写入是 O(1) 追加 (不需要读改写, 不与并发写打架)。
//   2. **它是真相文件, 不是索引**: 只追加、永不改写, 坏了也只丢一行 —— "可重建"对它是空的。
//      因此不需要版本号/重建路径, 只需要保留期。
//   3. **与捕获解耦**: 捕获有 autoCapture 开关且可能走 LLM; 账本是纯本地小追加, 关掉它
//      就完全看不到注入行为。因此它由**自己的**开关 (scheduleLog) 控制, 且写入永远 best-effort
//      (失败静默, 绝不拖垮对话 —— 记忆层不许影响宿主)。
//
// 落盘语义 (按天分文件 / 行数上限 / 保留期 / best-effort) 与捕获耗时账本是同一套,
// 因此实现在 jsonl-ledger.ts 里只有一份; 本文件只负责**记录形状与聚合视图**。
import { join } from "node:path";
import type { TriggerDecision } from "../../trigger/policy.ts";
import { JsonlLedger } from "./jsonl-ledger.ts";

/** 账本目录 (与 episodes 平级: 都是"可人读的真相文件")。 */
export const SCHEDULE_DIR = "schedule";

/** 默认保留天数 (0 = 永久)。比 episode 的 90 天短: 它是可观测性账本, 不是重放输入。 */
export const DEFAULT_SCHEDULE_RETENTION_DAYS = 14;
/** 单日文件行数上限 (超过当天不再写) —— 账本不许长成拖垮宿主的东西。 */
export const DEFAULT_SCHEDULE_MAX_LINES = 2000;

/** 一次注入调度的落盘形状 (给人和机器的证据, 不是内部状态转储)。 */
export interface ScheduleRecord {
  /** 落盘时间 (ISO)。 */
  at: string;
  /** 会话 id (账本跨会话, 必须能按会话切)。 */
  session: string;
  /** 项目键 (面板按项目过滤)。 */
  project?: string;
  /** 会话内步序 (宿主给的 step; 缺失时记 0)。 */
  step: number;
  /** 注入通道: binding = 项目声明式绑定; trigger = 通用触发通道; none = 没有可走的路。 */
  channel: "binding" | "trigger" | "none";
  /** 触发决策模式 (binding 通道不经过 TriggerPolicy, 记 null)。 */
  mode: TriggerDecision["mode"] | null;
  /** 结果分类: 一眼看出"为什么这轮没内容"。 */
  outcome: "injected" | "skipped" | "nothing-new" | "empty";
  intent: string | null;
  confidence: number;
  topicDrift: number;
  /** 人可读理由 (TriggerDecision.reason 或 pre-step 的判定说明)。 */
  reason: string;
  /** 该通道本轮**选中**的条目 id (差量过滤之前)。 */
  selected: string[];
  /** 实际写出去的条目 id (差量过滤之后)。 */
  ids: string[];
  /**
   * 本轮注入块 token 估算。
   * 名字就是估算: 宿主没有"实际消耗"的接口, 这里与注入预算用同一把尺
   * (kernel/ranking.estimateTokens), 因此可比较、可加总, 但不假装是计量值。
   */
  tokens: number;
}

/** 面板聚合视图: 一个会话一行 (原始记录可能几百行, 直接铺出来没人看得下去)。 */
export interface ScheduleSessionSummary {
  session: string;
  project?: string;
  /** 该会话第一条/最后一条记录的时间。 */
  firstAt: string;
  lastAt: string;
  /** 记录条数 (= 预步判定次数)。 */
  steps: number;
  injected: number;
  skipped: number;
  /** 本会话注入 token 估算总和。 */
  tokens: number;
  /** 各 mode 出现次数 (为什么的分布)。 */
  modes: Record<string, number>;
  lastMode: string | null;
  lastOutcome: ScheduleRecord["outcome"];
  lastReason: string;
  lastIds: string[];
}

export interface ScheduleLogConfig {
  /** 记忆根目录 (账本落在 <root>/schedule/)。 */
  root: string;
  /** 保留天数 (0 = 永久); 允许传函数以便设置面板改动当轮生效。 */
  retentionDays?: number | (() => number);
  /** 单日行数上限; 同样允许传函数。 */
  maxLinesPerDay?: number | (() => number);
}

export class ScheduleLog {
  private readonly ledger: JsonlLedger;

  constructor(config: ScheduleLogConfig) {
    this.ledger = new JsonlLedger({
      dir: join(config.root, SCHEDULE_DIR),
      retentionDays: config.retentionDays ?? DEFAULT_SCHEDULE_RETENTION_DAYS,
      maxLinesPerDay: config.maxLinesPerDay ?? DEFAULT_SCHEDULE_MAX_LINES,
    });
  }

  /** 账本目录 (人可读位置; 备份/排查时按它取)。 */
  get dirPath(): string {
    return this.ledger.dirPath;
  }

  /** 最近一次写入是否失败过 (可观测: 静默失败也要能被问出来)。 */
  hasWriteFailed(): boolean {
    return this.ledger.hasWriteFailed();
  }

  /**
   * 追加一条记录。返回是否真的落盘。
   * 永不抛错: 账本写不进去不该让这一轮对话失败 (best-effort)。
   */
  append(record: ScheduleRecord): boolean {
    return this.ledger.appendLine(record, record.at);
  }

  /** 最近的记录 (新→旧)。坏行跳过 (账本损坏不该让整份不可读)。 */
  recent(limit = 100): ScheduleRecord[] {
    const out: ScheduleRecord[] = [];
    for (const line of this.ledger.lines(limit)) {
      const record = parseRecord(line);
      if (record) out.push(record);
    }
    return out;
  }

  /** 按会话聚合最近 limit 条记录 (面板主视图)。 */
  sessions(limit = 500): ScheduleSessionSummary[] {
    const bySession = new Map<string, ScheduleSessionSummary>();
    // 记录是新→旧的, 所以"第一次见到"就是该会话的最新一条。
    for (const r of this.recent(limit)) {
      const existing = bySession.get(r.session);
      if (!existing) {
        bySession.set(r.session, {
          session: r.session,
          ...(r.project ? { project: r.project } : {}),
          firstAt: r.at,
          lastAt: r.at,
          steps: 1,
          injected: r.outcome === "injected" ? 1 : 0,
          skipped: r.outcome === "injected" ? 0 : 1,
          tokens: r.tokens,
          modes: r.mode ? { [r.mode]: 1 } : {},
          lastMode: r.mode,
          lastOutcome: r.outcome,
          lastReason: r.reason,
          lastIds: r.ids,
        });
        continue;
      }
      existing.firstAt = r.at;
      existing.steps += 1;
      existing.tokens += r.tokens;
      if (r.outcome === "injected") existing.injected += 1;
      else existing.skipped += 1;
      if (r.mode) existing.modes[r.mode] = (existing.modes[r.mode] ?? 0) + 1;
      if (r.project && !existing.project) existing.project = r.project;
    }
    return [...bySession.values()];
  }

  /** 账本文件数 / 记录条数 (面板顶部的体量信息)。 */
  size(): { files: number; records: number } {
    return this.ledger.size();
  }

  /** 按保留期清理整天文件。retentionDays<=0 时是 no-op。 */
  prune(now = new Date().toISOString()): number {
    return this.ledger.prune(now);
  }
}

/** 解析一行; 坏行返回 null (跳过而不是抛错)。 */
export function parseRecord(line: string): ScheduleRecord | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const raw = JSON.parse(trimmed) as Record<string, unknown>;
    if (typeof raw.at !== "string" || typeof raw.session !== "string") return null;
    return {
      at: raw.at,
      session: raw.session,
      ...(typeof raw.project === "string" ? { project: raw.project } : {}),
      step: typeof raw.step === "number" ? raw.step : 0,
      channel: raw.channel === "binding" || raw.channel === "none" ? raw.channel : "trigger",
      mode: typeof raw.mode === "string" ? (raw.mode as TriggerDecision["mode"]) : null,
      outcome:
        raw.outcome === "skipped" || raw.outcome === "nothing-new" || raw.outcome === "empty"
          ? raw.outcome
          : "injected",
      intent: typeof raw.intent === "string" ? raw.intent : null,
      confidence: typeof raw.confidence === "number" ? raw.confidence : 0,
      topicDrift: typeof raw.topicDrift === "number" ? raw.topicDrift : 0,
      reason: typeof raw.reason === "string" ? raw.reason : "",
      selected: Array.isArray(raw.selected) ? raw.selected.map(String) : [],
      ids: Array.isArray(raw.ids) ? raw.ids.map(String) : [],
      tokens: typeof raw.tokens === "number" ? raw.tokens : 0,
    };
  } catch {
    return null;
  }
}
