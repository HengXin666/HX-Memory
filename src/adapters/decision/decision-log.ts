// src/adapters/decision/decision-log.ts — 决策账本: "判什么/判成什么/为什么降级" 的落盘端。
//
// ## 为什么必须有它 (本仓的既有教训)
//
// schedule-log 的头注释写着同一句话: "'为什么没注入' 必须和 '注入了什么' 一样可查" ——
// 而那个功能写了很久才兑现, 期间只能读源码猜。决策层面临**完全相同**的风险, 且更严重:
// 判官会**静默失灵** (上游 500 / key 过期 / 提示词换坏), 而失灵的表现是"注入行为悄悄变了",
// 从业务侧完全看不出原因。
//
// 更具体的一条: 用户要求"**失败 n 次就不显示**"。这个"不显示"如果不可观测, 就会变成
// "功能莫名消失" —— 用户看到的是记忆插件不再注入, 而没有任何地方说"因为判官连续 3 次
// 没把握, 我们停用了它"。因此熔断/降级**必须**同时落盘。
//
// ## 三条形态取舍 (与 schedule-log / capture-log 同一套, 不另起一套)
//
//   1. **JSONL 追加**: 一天一个文件, 一行一条。人能 tail, 机器能解析, 写入 O(1) 不打架。
//   2. **它是真相文件, 不是索引**: 只追加、永不改写, 坏了只丢一行 ⇒ 没有重建路径, 只有保留期。
//   3. **best-effort**: 写失败静默 (记忆层不许拖垮对话), 但置一个可观测标志。
//
// 落盘语义 (按天分文件/行数上限/保留期/best-effort) 全在 `JsonlLedger` 里, 本文件只定义
// **记录形状**与聚合视图 —— 那段语义在本仓已经有唯一实现, 不许再写第二遍。
import { JsonlLedger } from "../dsh/jsonl-ledger.ts";

/** 账本目录名 (与 episodes/schedule/capture 平级: 都是人可读的真相文件)。 */
export const DECISION_DIR = "decision-log";

/** 默认保留天数。决策是每轮都可能发生的**高频**记录, 因此比 episode 短得多。 */
export const DEFAULT_DECISION_RETENTION_DAYS = 7;
/** 单日行数上限 (到顶拒写, 不轮转) —— 账本不许长成拖垮宿主的东西。 */
export const DEFAULT_DECISION_MAX_LINES = 2000;

/** 一次决策的落盘形状 (给人和机器的证据, 不是内部状态转储)。 */
export interface DecisionRecord {
  /** 落盘时间 (ISO)。 */
  at: string;
  /** 判定用途 (如 "recall-gate"): 一个账本里会有多种判定, 必须能切开看。 */
  purpose: string;
  /** 判定实现名 (jev / heuristic / none)。 */
  adapter: string;
  /**
   * 结果分类。四态而不是布尔:
   *   · `used`      —— 采信了判官结果;
   *   · `upgraded`  —— 判官没把握, 交回业务判定 (单次);
   *   · `circuit`   —— 处于熔断冷却, 压根没调判官 (系统性失灵);
   *   · `error`     —— 调用层失败 (脚本缺失/超时/非 JSON 输出)。
   * 后两者分开, 因为处置不同: 前者等冷却, 后者要人去查环境。
   */
  outcome: "used" | "upgraded" | "circuit" | "error";
  /** 判官自报的一一致度与锐度 (证据, 不是正确度)。 */
  agreement?: number;
  sharpness?: number;
  /** 判定的问题数 (多问题时看规模)。 */
  questions?: number;
  /** 采信的那个答案 (choice 值; 便于事后统计"它通常怎么判")。 */
  choice?: string;
  /** 降级/失败原因 (直接来自回退控制器的 reason, 保证与决策路径同源)。 */
  reason?: string;
  /** 判定耗时 (ms)。判官是同步路径上的开销, "慢了多少"必须可查。 */
  elapsedMs?: number;
  /** 熔断计数 (只有 outcome=circuit 时有意义, 用来回答"这是第几次")。 */
  circuitTrips?: number;
}

/** 聚合视图 (面板/CLI 用; 不落盘, 现算)。 */
export interface DecisionLogSummary {
  /** 总记录数。 */
  total: number;
  byOutcome: Record<string, number>;
  /**
   * **未被采用的判定**占全部的比例 = (upgraded + circuit + error) / total。
   *
   * 三种都要算 (2026-09-29 由测试抓出漏算): 判官"没把握"、"被熔断"、"调用失败"时,
   * 结果**一样都没有被采用** —— 只看前两者会让"判官一直报错"这件事在指标上不可见
   * (而它恰恰是最常见的失灵形态: key 过期 / 上游 500)。
   * 这条指标回答的是用户的问题: "判官最近到底有没有在工作"。
   */
  degradedRate: number;
  /**
   * 判官**压根没给出可用结果**的次数 (error + circuit)。
   *
   * 与 `degradedRate` 的差别: 后者还包含"给了结果但没把握"(upgraded) —— 那说明判官在跑
   * 只是不敢信; 而这里是"它没能跑起来"。两者的处置不同 (调阈值 vs 修环境/等冷却)。
   */
  unavailable: number;
  /** 触发过熔断的次数 (去重后的最大 circuitTrips)。 */
  circuitTrips: number;
}

export interface DecisionLogOptions {
  /** 记忆根目录 (账本落在 <root>/decision-log)。 */
  root: string;
  /** 保留天数 (0 = 永久); 传函数以便设置改动当轮生效。 */
  retentionDays?: number | (() => number);
}

/** 决策账本。写入永远 best-effort; 读侧只服务"事后追因"。 */
export class DecisionLog {
  private readonly ledger: JsonlLedger;

  constructor(options: DecisionLogOptions) {
    this.ledger = new JsonlLedger({
      dir: options.root + "/" + DECISION_DIR,
      retentionDays: options.retentionDays ?? DEFAULT_DECISION_RETENTION_DAYS,
      maxLinesPerDay: DEFAULT_DECISION_MAX_LINES,
    });
  }

  /**
   * 追加一条决策记录 (不抛错; 失败只置可观测标志)。
   *
   * 时间**由账本自己盖**: `at` 既决定落在哪个日文件里, 也写进记录正文 —— 两者必须同源,
   * 否则跨零点那一条会出现"文件名是今天、正文里的时间是昨天"的分裂 (读侧按 at 过滤时就会错)。
   */
  append(record: Omit<DecisionRecord, "at">, at = new Date().toISOString()): void {
    this.ledger.appendLine({ ...record, at }, at);
  }

  /** 读最近的记录 (新→旧; 坏行跳过, 不让整份不可读)。 */
  recent(limit = 200): DecisionRecord[] {
    return this.ledger
      .lines(limit)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as DecisionRecord];
        } catch {
          return [];
        }
      });
  }

  /** 聚合视图: 回答"判官最近可信吗"。 */
  summary(limit = 2000): DecisionLogSummary {
    const rows = this.recent(limit);
    const byOutcome: Record<string, number> = {};
    let circuitTrips = 0;
    for (const r of rows) {
      byOutcome[r.outcome] = (byOutcome[r.outcome] ?? 0) + 1;
      circuitTrips = Math.max(circuitTrips, r.circuitTrips ?? 0);
    }
    const degraded = (byOutcome.upgraded ?? 0) + (byOutcome.circuit ?? 0) + (byOutcome.error ?? 0);
    return {
      total: rows.length,
      byOutcome,
      degradedRate: rows.length ? degraded / rows.length : 0,
      unavailable: (byOutcome.error ?? 0) + (byOutcome.circuit ?? 0),
      circuitTrips,
    };
  }

  /** 启动时清一次过期账本 (只跑一次; 与 scheduleLog 同位置同理由 —— 不需要后台定时器)。 */
  prune(now = new Date().toISOString()): number {
    return this.ledger.prune(now);
  }

  /** 写失败标志 (best-effort 的唯一可观测面: 静默失败要能被发现)。 */
  hasWriteFailed(): boolean {
    return this.ledger.hasWriteFailed();
  }
}
