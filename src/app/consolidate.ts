// app/consolidate.ts — 后台整合 (S3): 衰减扫描 / 显式 TTL / 报告 (见 docs/architecture-v2.md §4.4)。
//
// 设计原则 (为什么这么保守):
//   1. **永不删除**: "过期"只是 status=expired —— 检索默认不返回, 真相文件里仍在, 面板可查可复活;
//   2. **只对短命种类生效**: 默认只让 event/context 过期; lesson/decision/pattern/preference/fact 只降权不消失,
//      规则 (rule) 永远不动 (人工闸门是产品承诺, 见 ADR-003);
//   3. **有命中就有生命**: 只要被召回强化过 (reinforcement>0) 或最近命中过 (lastHitAt), 就不判过期;
//   4. **可干跑**: dryRun 只出报告不写盘, 便于人在面板上先看"这次会过期哪些"。
//
// 它不做什么: 不做语义合并、不做摘要重写 (那是需要 LLM 的 S2/S3 增强, 且必须有闸门);
// 本服务只做"确定性的、可解释的、可逆的"那一部分。
import type { MemoryEntry, MemoryKind } from "../kernel/types.ts";
import type { MemoryStore } from "../kernel/ports.ts";
import { HALF_LIFE_DAYS, timeDecayFactor } from "../kernel/ranking.ts";

/** 默认可自动过期的种类 (短命记忆)。 */
export const DEFAULT_EXPIRABLE_KINDS: readonly MemoryKind[] = ["event", "context"];

export interface ConsolidateOptions {
  /** 干跑: 只报告, 不写盘。 */
  dryRun?: boolean;
  /** 过期阈值: 衰减因子低于它才考虑 (默认 0.15)。 */
  decayThreshold?: number;
  /** 覆盖可过期种类 (白名单; rule 会被强制剔除)。 */
  expirableKinds?: readonly MemoryKind[];
  /** 判定时间点 (默认 now)。 */
  now?: string;
}

export interface ConsolidateReport {
  /** 扫描的 active 条目数。 */
  scanned: number;
  /** 本次判为过期 (或干跑下"将会过期") 的 id → 原因。 */
  expiring: Array<{ id: string; kind: MemoryKind; reason: "ttl" | "decay"; decay: number }>;
  /** 被保护而跳过的条目数与原因统计 (可观测)。 */
  protectedByKind: number;
  protectedByReinforcement: number;
  applied: boolean;
}

export interface ConsolidationDeps {
  store: MemoryStore;
  now?: () => string;
}

export class ConsolidationService {
  private readonly store: MemoryStore;
  private readonly now: () => string;

  constructor(deps: ConsolidationDeps) {
    this.store = deps.store;
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  /**
   * 跑一次衰减扫描。幂等: 已经 expired 的条目不再重复处理;
   * 只有显式 TTL 到期或"衰减到底且从未被命中"才判过期。
   */
  async run(opts: ConsolidateOptions = {}): Promise<ConsolidateReport> {
    const at = opts.now ?? this.now();
    const threshold = opts.decayThreshold ?? 0.15;
    const kinds = (opts.expirableKinds ?? DEFAULT_EXPIRABLE_KINDS).filter((k) => k !== "rule");
    const expirable = new Set<MemoryKind>(kinds);
    const report: ConsolidateReport = {
      scanned: 0,
      expiring: [],
      protectedByKind: 0,
      protectedByReinforcement: 0,
      applied: opts.dryRun !== true,
    };

    const all = await this.store.all();
    for (const entry of all) {
      if ((entry.status ?? "active") !== "active") continue;
      report.scanned++;
      if (!expirable.has(entry.kind)) {
        report.protectedByKind++;
        continue;
      }
      const ttlHit = entry.expiresAt !== undefined && entry.expiresAt <= at;
      const baseline = entry.lastHitAt ?? entry.ts.validAt;
      const ageDays = (Date.parse(at) - Date.parse(baseline)) / 86_400_000;
      const halfLife = HALF_LIFE_DAYS[entry.kind] ?? 180;
      const decay = timeDecayFactor(Number.isFinite(ageDays) ? Math.max(0, ageDays) : 0, halfLife);
      const reinforced = (entry.reinforcement ?? 0) > 0;
      if (!ttlHit) {
        if (reinforced || decay >= threshold) {
          if (reinforced) report.protectedByReinforcement++;
          continue;
        }
      }
      report.expiring.push({
        id: entry.id,
        kind: entry.kind,
        reason: ttlHit ? "ttl" : "decay",
        decay: Number(decay.toFixed(4)),
      });
      if (opts.dryRun) continue;
      await this.store.update(entry.id, { status: "expired" } as Partial<MemoryEntry>);
    }
    return report;
  }

  /** 复活: 把 expired 拉回 active (人改主意 / 记忆又变得相关)。 */
  async revive(id: string): Promise<void> {
    const entry = await this.store.get(id);
    if (!entry) throw new Error("revive: not found: " + id);
    if ((entry.status ?? "active") === "active") return;
    await this.store.update(id, { status: "active" } as Partial<MemoryEntry>);
  }
}
