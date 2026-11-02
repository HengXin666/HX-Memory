// adapters/dsh/ledgers-wiring.ts — 注入调度账本与捕获耗时账本的构造 (2026-11-02 从 index.ts 拆出, verify-structure 400 行约束)。
import { ScheduleLog } from "./schedule-log.js";
import { CaptureLog } from "./capture-log.js";

export function makeLedgers(root: string, settings: () => { scheduleLog: boolean; scheduleLogRetentionDays: number; captureLog: boolean; captureRetentionDays: number }): { scheduleLog: ScheduleLog; captureLog: CaptureLog } {
  // 注入调度账本 (可观测性真相文件): 每一步的判定都落一条, 含"没注入"的那几种。
  // 保留期按函数传入  面板改设置当轮生效 (与 episode 同一套理由)。
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
  return { scheduleLog, captureLog };
}
