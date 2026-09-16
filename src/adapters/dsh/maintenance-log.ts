// adapters/dsh/maintenance-log.ts — 后台维护的**结果记录** (环形缓冲, 供面板展示)。
//
// 为什么是内存缓冲而不是像调度账本那样落盘: 两者的时间尺度不同。调度账本回答"昨天那轮为什么
// 没注入" (跨进程重启的排查), 而维护回答"它最近有没有在工作" —— 一个只发生在空闲期的后台任务,
// 用户最需要的是"面板上能看见最近几次的结果"。落盘会让它多一份保留期管理, 而收益很小。
//
// 代价说清楚: 进程重启后历史清空。这是刻意的取舍, 不是遗漏。
import type { MaintenanceRecord } from "./scheduler.ts";

export const DEFAULT_MAINTENANCE_HISTORY = 20;

export class MaintenanceLog {
  private readonly cap: number;
  private readonly records: MaintenanceRecord[] = [];

  constructor(cap = DEFAULT_MAINTENANCE_HISTORY) {
    this.cap = Math.max(1, cap);
  }

  push(record: MaintenanceRecord): void {
    this.records.push(record);
    // 新的在前: 面板渲染直接按顺序取前 N 条, 不需要排序。
    while (this.records.length > this.cap) this.records.shift();
  }

  /** 最近的记录 (新 → 旧)。 */
  recent(limit = this.cap): MaintenanceRecord[] {
    const n = Math.max(0, Math.min(limit, this.records.length));
    return this.records.slice(-n).reverse();
  }

  /** 最近一次**真正执行**的记录 (跳过的不算); 没有则 null。 */
  lastRun(): MaintenanceRecord | null {
    for (let i = this.records.length - 1; i >= 0; i--) {
      const r = this.records[i];
      if (r?.ran) return r;
    }
    return null;
  }

  size(): number {
    return this.records.length;
  }
}
