// src/adapters/decision/fallback.ts — 决策回退控制器: 判官不可信时, 交回业务自身判定。
//
// ## 为什么需要它
//
// 判官是**概率模型**, 有两条硬边界 (HX-Jungle 实测标定, 本仓沿用同一结论):
//   1. state 含糊时它会**稳定地给同一个错答案**, 且置信度 1.00 (实测 12/12);
//   2. 高置信度/高一致度 **!= 正确** (它只证明"输入指向同一结论")。
// 所以任何把它当权威用的地方都必须有出口 —— 否则"判官失灵"会变成"记忆静默错掉"。
//
// ## 两层回退 (这个区分是关键)
//
// **第一层: 单次不可信 -> 升级**
//   判据是**信号**, 不是"正确答案":
//     · agreement < agreeMin  (采样之间在分歧)
//     · sharpness < sharpMin  (候选之间模型自己也没区分开)
//     · 判官报错 / 不可用
//   这些都在说"这次它没把握"。有把握时省时间, 没把握时不许硬猜。
//
// **第二层: 系统性失灵 -> 熔断, 整体停用 ("失败 n 次就不显示")**
//   单次升级解决不了"它整体已经不对了"的情况 (提示词换了 / 模型降级 / 上游改行为)。
//   判据是**统计的**而非单次的: 连续升级 N 次, 或窗口内升级率超阈值。
//   触发即进入冷却期, 冷却期内**直接走业务判定, 连判官都不调** —— 省掉那 0.45s 的无效开销。
//   冷却结束后恢复探测 (半开): 放一次过去试, 成功就复位, 失败就继续熔断。
//
// 为什么两层都要有: 只有第一层, 提示词换坏之后每一步都要先白花 0.45s 再升级;
// 只有第二层, 单次异常会被当成系统性失灵。
//
// ## 本层不实现决策, 只管"谁来决策"
//
// 它**不知道**任何模型、不做任何判定, 只做三件事: 读信号、决定路径、记状态。
// 真正干活的是 DecisionPort 的实现 (可替换)。所以换判官不用改这里。
//
// ## 状态必须跨进程存活 (踩过的坑)
//
// 熔断状态落盘到 `<root>/decision/<name>.json`: 不落盘的话每次重启都从头犯错 ——
// 而"重启"在插件热重载下是常事, 于是熔断永远追不上失灵。

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DecisionOutcome } from "../../kernel/ports-decision.ts";

/** 回退策略。调用方按自己的容忍度调, 不要改代码里的常量。 */
export interface RoutePolicy {
  /** 一致度低于此 → 升级。 */
  agreeMin: number;
  /**
   * 锐度低于此 → 升级。
   *
   * 为什么是 0.35: 实测标定里"尖锐"场景 ~1.00、"平缓"场景 0.36 —— 取 0.35 意味着
   * 连最平缓的实测样本也仍被接受。这是**刻意的保守取向**: 升级代价 (多花几秒) 高于
   * 偶尔用一次低锐度结果。要更严就调高。
   */
  sharpMin: number;
  /** 连续 N 次升级 → 熔断。 */
  consecutiveUpgrades: number;
  /** 统计窗口 (最近 N 次决策)。 */
  upgradeRateWindow: number;
  /** 窗口内升级率超过此 → 熔断。 */
  upgradeRateMax: number;
  /** 熔断冷却时长 (ms)。 */
  cooldownMs: number;
}

export const DEFAULT_ROUTE_POLICY: RoutePolicy = {
  agreeMin: 0.6,
  sharpMin: 0.35,
  consecutiveUpgrades: 3,
  upgradeRateWindow: 10,
  upgradeRateMax: 0.7,
  cooldownMs: 300_000,
};

/** 一次路由的结果。调用方据此决定"用谁给的东西"以及"要不要告诉用户"。 */
export interface RouteDecision {
  /** true = 采用判官结果; false = 该走业务自身判定。 */
  usePrimary: boolean;
  /** 为什么这么路由 (可解释, 便于事后追因)。 */
  reason: string;
  /** 是否发生了升级。 */
  upgraded: boolean;
  /** 是否处于熔断/冷却中。 */
  circuitOpen: boolean;
  /** 触发判定的信号快照 (进日志)。 */
  signals: Record<string, unknown>;
}

/** 控制器自身的统计。**要暴露给观测面** —— "熔断了但没人知道"是最坏情况。 */
export interface RouteStats {
  total: number;
  upgraded: number;
  circuitTrips: number;
  consecutiveUpgrades: number;
  /** 最近的升级与否 (滑动窗口)。 */
  recent: boolean[];
  /** 熔断开始的时刻 (ms; 0 = 未熔断)。 */
  openedAt: number;
}

export interface FallbackControllerOptions {
  policy?: Partial<RoutePolicy>;
  /** 状态文件名 (落盘用)。不传则只在内存里记 (测试用)。 */
  persistAs?: string;
  /** 状态目录 (默认 <root>/decision)。 */
  stateDir?: string;
  /** 现在 (可注入, 便于测试冷却)。 */
  now?: () => number;
}

/**
 * 两层回退控制器。不实现决策, 只决定"谁来决策"。
 *
 * 术语取 `RouteDecision` 而不是 `JudgeDecision`: 它路由的是"用谁的结果",
 * 不是"判定对错" —— 后者本层无从知道 (见文件头注的纪律)。
 */
export class FallbackController {
  private readonly policy: RoutePolicy;
  private readonly persistAs: string;
  private readonly stateDir: string;
  private readonly now: () => number;
  readonly stats: RouteStats = {
    total: 0,
    upgraded: 0,
    circuitTrips: 0,
    consecutiveUpgrades: 0,
    recent: [],
    openedAt: 0,
  };

  constructor(options: FallbackControllerOptions = {}) {
    this.policy = { ...DEFAULT_ROUTE_POLICY, ...options.policy };
    this.persistAs = options.persistAs ?? "";
    this.stateDir = options.stateDir ?? "";
    this.now = options.now ?? (() => Date.now());
    this.load();
  }

  // ── 持久化: 熔断状态必须跨进程存活 (见文件头注) ──────────────────────────────

  private statePath(): string | undefined {
    if (!this.persistAs || !this.stateDir) return undefined;
    const safe = this.persistAs.replace(/[^A-Za-z0-9\-_.]/g, "_");
    return join(this.stateDir, safe + ".json");
  }

  private load(): void {
    const file = this.statePath();
    if (!file) return;
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<RouteStats>;
      this.stats.total = Number(raw.total ?? 0);
      this.stats.upgraded = Number(raw.upgraded ?? 0);
      this.stats.circuitTrips = Number(raw.circuitTrips ?? 0);
      this.stats.consecutiveUpgrades = Number(raw.consecutiveUpgrades ?? 0);
      this.stats.recent = Array.isArray(raw.recent) ? raw.recent.slice(-50).map(Boolean) : [];
      this.stats.openedAt = Number(raw.openedAt ?? 0);
    } catch {
      // 状态损坏不致命: 重置即可 (代价是丢掉熔断记忆, 不是崩溃)。
    }
  }

  private save(): void {
    const file = this.statePath();
    if (!file) return;
    try {
      mkdirSync(dirname(file), { recursive: true });
      const tmp = file + ".tmp";
      writeFileSync(tmp, JSON.stringify(this.stats), "utf8");
      // 原子替换: 进程在两次写之间被杀也不会留下半个 JSON (与 storage 的写盘同一纪律)。
      renameSync(tmp, file);
    } catch {
      // 状态写失败不该影响决策路径 (记忆层不许拖垮宿主)。
    }
  }

  // ── 熔断状态 ──────────────────────────────────────────────────────────────

  /** 是否处于冷却期。冷却结束即视为半开 (允许探测)。 */
  circuitOpen(): boolean {
    if (this.stats.openedAt <= 0) return false;
    return this.now() - this.stats.openedAt < this.policy.cooldownMs;
  }

  /** 手动复位 (用户发现"它现在对了"时可调)。 */
  reset(): void {
    this.stats.openedAt = 0;
    this.stats.consecutiveUpgrades = 0;
    this.stats.recent = [];
    this.save();
  }

  /** 窗口内升级率。 */
  upgradeRate(): number {
    if (this.stats.recent.length === 0) return 0;
    return this.stats.recent.filter(Boolean).length / this.stats.recent.length;
  }

  // ── 核心: 路由 ────────────────────────────────────────────────────────────

  /**
   * 读判官结果, 决定用还是回退。
   *
   * @param result 判官输出 (ok/agreement/sharpness/error)。
   * @returns 路由决定 (含可解释的 reason 与信号快照)。
   */
  route(result: Pick<DecisionOutcome, "ok" | "agreement" | "sharpness" | "error">): RouteDecision {
    const signals: Record<string, unknown> = {
      ok: result.ok,
      agreement: result.agreement,
      sharpness: result.sharpness,
      error: result.error,
    };

    // 熔断期: 连判官都不调 (调用方应在此之前就问 `circuitOpen()`, 这里是兜底)。
    if (this.circuitOpen()) {
      this.record(true);
      return {
        usePrimary: false,
        reason: "熔断冷却中: 直接走业务判定 (不调判官)",
        upgraded: true,
        circuitOpen: true,
        signals,
      };
    }

    const reasons: string[] = [];
    if (!result.ok) reasons.push("判官报错或不可用: " + (result.error || "unknown"));
    else {
      if (result.agreement < this.policy.agreeMin) {
        reasons.push(`一致度 ${result.agreement.toFixed(2)} < ${this.policy.agreeMin} (采样在分歧)`);
      }
      if (typeof result.sharpness === "number" && result.sharpness < this.policy.sharpMin) {
        reasons.push(`锐度 ${result.sharpness.toFixed(2)} < ${this.policy.sharpMin} (候选没区分开)`);
      }
    }

    const upgraded = reasons.length > 0;
    this.record(upgraded);
    if (upgraded) {
      this.maybeTrip();
      return {
        usePrimary: false,
        reason: "升级给业务判定: " + reasons.join("; "),
        upgraded: true,
        circuitOpen: this.circuitOpen(),
        signals,
      };
    }
    return {
      usePrimary: true,
      reason: `判官结果可用 (一致度 ${result.agreement.toFixed(2)})`,
      upgraded: false,
      circuitOpen: false,
      signals,
    };
  }

  /** 记一次决策 (超窗即滑出)。 */
  private record(upgraded: boolean): void {
    this.stats.total += 1;
    if (upgraded) this.stats.upgraded += 1;
    this.stats.recent.push(upgraded);
    if (this.stats.recent.length > this.policy.upgradeRateWindow) {
      this.stats.recent = this.stats.recent.slice(-this.policy.upgradeRateWindow);
    }
    this.stats.consecutiveUpgrades = upgraded ? this.stats.consecutiveUpgrades + 1 : 0;
    // ⚠ 每次决策**都**检查熔断, 不只在升级时 —— 否则"散发式失灵"抓不到:
    // 升级/成功交替时连续计数永远归零, 只有窗口率能发现它, 而如果只在升级那一次检查,
    // 窗口长度可能刚好还没被填满 (实测用例: [up,ok,up,ok] 四次都没触发)。
    // 每次都检查没有副作用: 全成功时 rate=0, 不会误熔断。
    this.maybeTrip();
    this.save();
  }

  /** 判据是**统计的**: 连续 N 次升级, 或窗口升级率超阈值。 */
  private maybeTrip(): void {
    if (this.circuitOpen()) return;
    const byStreak = this.stats.consecutiveUpgrades >= this.policy.consecutiveUpgrades;
    const byRate =
      this.stats.recent.length >= this.policy.upgradeRateWindow &&
      this.upgradeRate() > this.policy.upgradeRateMax;
    if (!byStreak && !byRate) return;
    this.stats.circuitTrips += 1;
    this.stats.openedAt = this.now();
  }

  /** 导出给观测面/日志用 (熔断要可见, 否则"静默降级"就是这个功能的失败模式)。 */
  status(): RouteStats & { upgradeRate: number; circuitOpen: boolean } {
    return { ...this.stats, upgradeRate: this.upgradeRate(), circuitOpen: this.circuitOpen() };
  }
}
