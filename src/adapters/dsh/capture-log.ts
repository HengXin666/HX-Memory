// src/adapters/dsh/capture-log.ts — 捕获耗时账本 (回答"沉淀有没有把对话拖慢")。
//
// 为什么需要它 (真实缺口): 捕获链路对宿主是**异步**的 —— index.ts 用 `void runtime.capture(...)`
// 把它丢掉, DSH 的 session/event 派发也不 await 监听器。但"不阻塞"不等于"不花时间": 它与对话跑在
// 同一个进程、同一个 event loop 上, 而且它自己会调一次 LLM 做结构化。于是"这一轮怎么比平时慢"
// 在证据上完全无法回答 —— 唯一的计时证据是 llm-agent.ts 里的一行 ctx.logger, 而那是宿主日志,
// 与"这一轮对话"对不上号, 重启后也拿不到。这正是 schedule-log 当年解决的同一类问题
// (判定没有落盘 → 只能读源码猜), 只是换到了耗时轴。
//
// 形状 (与 schedule-log 同构, 共享 jsonl-ledger.ts):
//   - 一条 turn **一行**, 记录该轮从入队到落盘结束的**每一段**耗时与结果;
//   - 账本是真相文件: 只追加、永不改写, 因此没有重建路径, 只有保留期 (默认 7 天, 单日 4000 行);
//   - 写入 best-effort: append 不抛错, 失败只置 hasWriteFailed() —— 记时间的动作不许自身成为故障源。
//
// 一段不能省的话: 宿主**没有**"这一轮对话总共花了多久"的稳定接口, 因此本账本刻意不自称端到端
// 性能。`totalMs` 记的是"捕获自己在 turn/end 之后又占用了多久", 它才是"记忆层拖慢下一轮"的
// 可归因量。把它当成"对话延迟"来读是误读。
import { join } from "node:path";
import { JsonlLedger } from "./jsonl-ledger.ts";

/** 账本目录 (与 episodes/schedule 平级: 都是"可人读的真相文件")。 */
export const CAPTURE_DIR = "capture";
/** 默认保留天数 (0 = 永久)。比 episode 短: 它是性能观测, 不是重放输入。 */
export const DEFAULT_CAPTURE_RETENTION_DAYS = 7;
/** 单日文件行数上限 (超过当天不再写)。按"每次捕获一条"估算, 4000 行 ≈ 数千轮对话。 */
export const DEFAULT_CAPTURE_MAX_LINES = 4000;

/** 一轮为什么没有产生任何条目。 */
export type CaptureSkipReason =
  /** autoCapture 关着。 */
  | "disabled"
  /** subagent 会话 (rootAgentsOnly)。 */
  | "subagent"
  /** 这一步没有可落盘的 turn (未完成/无用户消息/被其他会话处理)。 */
  | "no-turn"
  /** 引擎判据挡掉 (问句无结论/无信号/指纹重复)。 */
  | "no-signal"
  /** 结构化器读不出结论 (疑问句开头的轮次)。 */
  | "no-conclusion"
  /** 落盘抛错。 */
  | "error";

/**
 * 一条捕获记录 = 一轮问答落盘的全过程。
 *
 * 单位是**轮**而不是"条": 一轮最多落 1 条记忆 (captureTurn 的契约), 分成多条会让
 * "这一轮花了多久"要跨行求和, 而排查时人只会看一行。
 */
export interface CaptureRecord {
  /** 开始时间 (ISO)。 */
  at: string;
  session: string;
  project?: string;
  /** 该会话内第几轮 (与 episode 的 turn 同源, 便于和原文对上)。 */
  turn: number;
  /** 结果: stored = 有条目落盘; skipped = 判定为不该存; error = 抛错。 */
  outcome: "stored" | "skipped" | "error";
  skip?: CaptureSkipReason;
  /** 落盘条数 (正常是 0 或 1)。 */
  entries: number;
  /** 本轮问题/回答的字符数 (LLM 结构的输入规模, 是耗时的主要解释变量)。 */
  qChars: number;
  aChars: number;
  /** episode 追加耗时 (含两条原文)。 */
  episodeMs: number;
  /** 结构化器耗时 (调用方传入的真实 LLM 时间; 启发式兜底约 0)。 */
  enrichMs: number;
  /** 建结构关联边耗时 (要读全库做共现比较)。 */
  linkMs: number;
  /** 存储写入耗时。 */
  storeMs: number;
  /** 该轮捕获占用的总时间 (不包含宿主在别处花的时间)。 */
  totalMs: number;
  /** 失败原因 (outcome=error 时是异常信息, 否则是判据/引擎给出的 signal)。 */
  detail?: string;
}

export interface CaptureLogConfig {
  /** 记忆根目录 (账本落在 <root>/capture/)。 */
  root: string;
  /** 保留天数 (0 = 永久); 允许传函数以便设置面板改动当轮生效。 */
  retentionDays?: number | (() => number);
  /** 单日行数上限; 同样允许传函数。 */
  maxLinesPerDay?: number | (() => number);
}

export class CaptureLog {
  private readonly ledger: JsonlLedger;

  constructor(config: CaptureLogConfig) {
    this.ledger = new JsonlLedger({
      dir: join(config.root, CAPTURE_DIR),
      retentionDays: config.retentionDays ?? DEFAULT_CAPTURE_RETENTION_DAYS,
      maxLinesPerDay: config.maxLinesPerDay ?? DEFAULT_CAPTURE_MAX_LINES,
    });
  }

  get dirPath(): string {
    return this.ledger.dirPath;
  }

  /** 最近一次写入是否失败过 (静默失败也要能被问出来)。 */
  hasWriteFailed(): boolean {
    return this.ledger.hasWriteFailed();
  }

  /** 追加一条记录; 永不抛错 (best-effort)。 */
  append(record: CaptureRecord): boolean {
    return this.ledger.appendLine(record, record.at);
  }

  /** 最近的记录 (新→旧); 坏行跳过。 */
  recent(limit = 100): CaptureRecord[] {
    const out: CaptureRecord[] = [];
    for (const line of this.ledger.lines(limit)) {
      const record = parseCaptureRecord(line);
      if (record) out.push(record);
    }
    return out;
  }

  /**
   * 汇总视图: 最近 limit 条记录的分位数与分阶段均值。
   *
   * 为什么给分位数而不是只给平均: 慢捕获是**长尾**现象 (LLM 超时/上游排队), 平均值会被
   * 大量 1ms 的正常轮次稀释到看不出问题 —— 而需要回答的恰恰是"最慢的那些有多慢"。
   */
  stats(limit = 500): CaptureStats {
    // 全部记录交给 summarize: 耗时只统计有耗时意义的那些, 但"跳过了几轮/错了几轮"
    // 是"为什么没沉淀"的答案, 把跳过的行先滤掉就等于把它们从账里删掉。
    return summarize(this.recent(limit));
  }

  /** 账本文件数 / 记录条数。 */
  size(): { files: number; records: number } {
    return this.ledger.size();
  }

  /** 按保留期清理整天文件。retentionDays<=0 时是 no-op。 */
  prune(now = new Date().toISOString()): number {
    return this.ledger.prune(now);
  }
}

export interface CaptureStats {
  /** 参与统计的记录数 (跳过的不算: 它们没有耗时意义)。 */
  count: number;
  /** 跳过/出错的记录数 (它们同样是"为什么没沉淀"的答案)。 */
  skipped: number;
  errors: number;
  /** totalMs 的分位数。p50 是稳态, p95 才看得见长尾。 */
  totalMs: { p50: number; p95: number; max: number };
  /** 分阶段均值 (哪一段在吃时间)。 */
  mean: { episodeMs: number; enrichMs: number; linkMs: number; storeMs: number };
  /** 最慢的一条 (面板上"看这一条"的入口)。 */
  slowest?: CaptureRecord;
}

/** 取分位数 (最近邻法; 样本量本来就小, 插值只会造出不存在的数)。 */
function percentile(sorted: readonly number[], p: number): number {
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index] ?? 0;
}

function mean(xs: readonly number[]): number {
  if (!xs.length) return 0;
  return Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);
}

/** 把一批记录折成汇总 (纯函数: 面板与测试用同一份口径)。 */
export function summarize(records: readonly CaptureRecord[]): CaptureStats {
  const timed = records.filter((r) => r.outcome === "stored" || r.outcome === "error");
  const totals = timed.map((r) => r.totalMs).sort((a, b) => a - b);
  const slowest = records.reduce<CaptureRecord | undefined>(
    (worst, r) => (worst === undefined || r.totalMs > worst.totalMs ? r : worst),
    undefined,
  );
  return {
    count: timed.length,
    skipped: records.filter((r) => r.outcome === "skipped").length,
    errors: records.filter((r) => r.outcome === "error").length,
    totalMs: {
      p50: percentile(totals, 0.5),
      p95: percentile(totals, 0.95),
      max: totals.length ? (totals[totals.length - 1] ?? 0) : 0,
    },
    mean: {
      episodeMs: mean(timed.map((r) => r.episodeMs)),
      enrichMs: mean(timed.map((r) => r.enrichMs)),
      linkMs: mean(timed.map((r) => r.linkMs)),
      storeMs: mean(timed.map((r) => r.storeMs)),
    },
    ...(slowest ? { slowest } : {}),
  };
}

/** 解析一行; 坏行返回 null (跳过而不是抛错)。 */
export function parseCaptureRecord(line: string): CaptureRecord | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const raw = JSON.parse(trimmed) as Record<string, unknown>;
    if (typeof raw.at !== "string" || typeof raw.session !== "string") return null;
    const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    const outcome =
      raw.outcome === "skipped" || raw.outcome === "error" ? raw.outcome : "stored";
    return {
      at: raw.at,
      session: raw.session,
      ...(typeof raw.project === "string" ? { project: raw.project } : {}),
      turn: num(raw.turn),
      outcome,
      ...(typeof raw.skip === "string" ? { skip: raw.skip as CaptureSkipReason } : {}),
      entries: num(raw.entries),
      qChars: num(raw.qChars),
      aChars: num(raw.aChars),
      episodeMs: num(raw.episodeMs),
      enrichMs: num(raw.enrichMs),
      linkMs: num(raw.linkMs),
      storeMs: num(raw.storeMs),
      totalMs: num(raw.totalMs),
      ...(typeof raw.detail === "string" ? { detail: raw.detail } : {}),
    };
  } catch {
    return null;
  }
}
