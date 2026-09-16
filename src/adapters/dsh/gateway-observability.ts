// adapters/dsh/gateway-observability.ts — 面板两个"观测面" RPC 的**投影** (纯函数)。
//
// 为什么拆出来: gateway 是"薄投影层"的承诺 (见它的头注释), 而这两个出口的投影逻辑
// 都带自己的取舍 (裁剪上限、缺依赖时的降级形状、available 的语义)。放在 Gateway 类里
// 会让它越过 400 行上限, 也会把这层"纯投影"混进服务生命周期。
//
// 关键契约: **缺依赖时也要返回形状完整的对象**, 并让 available/enabled 如实说明状态 ——
// 面板据此显示"本宿主没有账本/维护已关闭", 而不是画一个说不清是"没数据"还是"没接上"的空白。
import type { ScheduleLog, ScheduleRecord, ScheduleSessionSummary } from "./schedule-log.js";
import type { CaptureLog, CaptureRecord, CaptureStats } from "./capture-log.js";
import type { MaintenanceLog } from "./maintenance-log.js";
import type { MaintenanceRecord } from "./scheduler.js";

export interface ScheduleLogView {
  available: boolean;
  sessions: ScheduleSessionSummary[];
  records: ScheduleRecord[];
  size: { files: number; records: number };
}

export interface CaptureLogView {
  available: boolean;
  /** 最近记录的汇总 (分位数 + 分阶段均值)。count=0 时各字段为 0, 不是 undefined。 */
  stats: CaptureStats;
  records: CaptureRecord[];
  size: { files: number; records: number };
}

export interface MaintenanceView {
  /** 周期 > 0 (用户没关掉它)。 */
  enabled: boolean;
  /** 现在**能**跑: 有 CLI 且已启用。enabled 但 available=false 说明"开了但找不到执行器"。 */
  available: boolean;
  intervalMs: number;
  idleMs: number;
  records: MaintenanceRecord[];
}

export function projectScheduleLog(
  log: Pick<ScheduleLog, "sessions" | "recent" | "size"> | undefined,
  limit?: number,
): ScheduleLogView {
  if (!log) return { available: false, sessions: [], records: [], size: { files: 0, records: 0 } };
  const n = limit ?? 120;
  return {
    available: true,
    sessions: log.sessions(Math.max(1, Math.min(5000, (limit ?? 500) * 4))),
    records: log.recent(Math.max(1, Math.min(500, n))),
    size: log.size(),
  };
}

/**
 * 捕获耗时账本的投影。
 *
 * 汇总与原始记录一起给: 汇总回答"整体慢不慢", 原始记录回答"是哪一轮、慢在哪一段"。
 * 只给汇总会让人无法定位, 只给原始记录则在几百轮里看不出长尾。
 */
export function projectCaptureLog(
  log: Pick<CaptureLog, "stats" | "recent" | "size"> | undefined,
  limit?: number,
): CaptureLogView {
  if (!log)
    return {
      available: false,
      stats: emptyCaptureStats(),
      records: [],
      size: { files: 0, records: 0 },
    };
  const n = Math.max(1, Math.min(500, limit ?? 120));
  return {
    available: true,
    stats: log.stats(Math.max(1, Math.min(5000, n * 4))),
    records: log.recent(n),
    size: log.size(),
  };
}

/** 缺依赖时的形状: 与"有数据但一条都没有"必须可区分 (available 才是那个区分位)。 */
function emptyCaptureStats(): CaptureStats {
  return {
    count: 0,
    skipped: 0,
    errors: 0,
    totalMs: { p50: 0, p95: 0, max: 0 },
    mean: { episodeMs: 0, enrichMs: 0, linkMs: 0, storeMs: 0 },
  };
}

export function projectMaintenance(deps: {
  maintenance?: Pick<MaintenanceLog, "recent" | "lastRun" | "size">;
  maintenanceConfig?: () => { intervalMs: number; idleMs: number; available: boolean };
}): MaintenanceView {
  const config = deps.maintenanceConfig?.() ?? { intervalMs: 0, idleMs: 0, available: false };
  return {
    enabled: config.intervalMs > 0,
    available: config.intervalMs > 0 && config.available,
    intervalMs: config.intervalMs,
    idleMs: config.idleMs,
    records: deps.maintenance?.recent(20) ?? [],
  };
}
