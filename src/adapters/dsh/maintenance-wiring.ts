// adapters/dsh/maintenance-wiring.ts — 后台维护的**组装** (把策略/执行/记录接成一个循环)。
//
// 为什么要有这个文件: 组装根 index.ts 已经接近 400 行上限, 而后台维护的接线有它自己的完整理由
// (为什么用子进程、为什么空闲窗、失败记什么)。把它整段放进 index.ts 会挤掉那里的可读性,
// 而这段代码**本来就能独立理解** —— 它的全部依赖都是注入的。
//
// 它不做的: 不决定"要不要维护"(那是 scheduler.ts 的纯函数判定), 不执行任务
// (那是 spawn-cli.ts 的子进程), 不保存结果 (那是 maintenance-log.ts 的环形缓冲)。
// 这里是唯一一处把它们连起来的地方, 也正因为如此, 它是**唯一**需要读 `settings()` 的装配点。
import type { Context } from "@deepseek-ai/cordis";
import type { HxMemorySettings } from "./types.js";
import { MaintenanceLog } from "./maintenance-log.js";
import {
  DEFAULT_MAINTENANCE_TASKS,
  MaintenanceLoop,
  type MaintenanceTaskName,
} from "./scheduler.js";
import { makeCliRunner } from "./spawn-cli.js";

export interface MaintenanceWiring {
  log: MaintenanceLog;
  loop: MaintenanceLoop;
  /** 现在能不能跑 (面板据此显示"已关闭/CLI 不可用"), 而不是让人去猜。 */
  available: () => boolean;
  /** 当前周期与空闲门槛 (面板显示用; 每次实时读设置)。 */
  config: () => { intervalMs: number; idleMs: number; available: boolean };
}

export function wireMaintenance(deps: {
  ctx: Context;
  root: string;
  settings: () => HxMemorySettings;
  /** 距离上次会话活动多久 (来自 runtime; 0 = 没有活动)。 */
  idleMs: () => number;
  /** 依赖注入点: 测试可换成假执行器, 避免单元测试真的启动子进程。 */
  runner?: ReturnType<typeof makeCliRunner>;
  log?: MaintenanceLog;
  /**
   * 可注入时钟与 tick 周期。
   *
   * 为什么必须从这里转发: 维护的判定全是时间比较 ("周期到了吗/空闲够久了吗")。
   * 若不透传, 任何针对接线的测试都只能靠真实计时器 sleep —— 慢且必然不稳。
   * 踩过: 加了这两个参数之前, 回放测试注入的时钟被静默忽略 (对象字面量的多余属性
   * 在 strip-only 运行时不报错), 于是 tick 用了真实时钟、断言全部错位。
   */
  now?: () => number;
  tickMs?: number;
}): MaintenanceWiring {
  const log = deps.log ?? new MaintenanceLog();
  const runner = deps.runner ?? makeCliRunner();
  const config = (): { intervalMs: number; idleMs: number; available: boolean } => ({
    intervalMs: deps.settings().maintenanceIntervalHours * 3_600_000,
    idleMs: deps.settings().maintenanceIdleMinutes * 60_000,
    available: runner.available() !== null,
  });
  const loop = new MaintenanceLoop({
    config: () => ({
      intervalMs: config().intervalMs,
      idleMs: config().idleMs,
      tasks: DEFAULT_MAINTENANCE_TASKS as readonly MaintenanceTaskName[],
    }),
    idleMs: deps.idleMs,
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.tickMs !== undefined ? { tickMs: deps.tickMs } : {}),
    // 不把任务名传给 CLI: CLI 只有一条 `maintain` (见 spawn-cli 的 MAINTENANCE_COMMAND 说明)。
    execute: async () => {
      if (!runner.available()) return { ok: false, detail: "cli-not-found", elapsedMs: 0 };
      return runner.run({
        root: deps.root,
        timeoutMs: 120_000,
        // 保留期实时读设置: 传 0 表示用户选择永久保留 (那时 prune 是有意的 no-op)。
        episodeRetentionDays: deps.settings().episodeRetentionDays,
      });
    },
    onRecord: (record) => {
      log.push(record);
      if (record.ok) {
        // 成功也记一行 (info): "维护有没有在工作"必须能从宿主日志看出来 ——
        // 静默成功与"从未触发"在日志里长得一样, 那就等于没有可观测性。
        try {
          deps.ctx
            .logger("hx-memory")
            .info("background maintenance ok: %s", record.tasks.join(","));
        } catch {
          // 日志失败不影响宿主
        }
        return;
      }
      // 失败必须留下**证据**: 只记 "exit:1" 等于没有信息 (踩过这个坑)。
      try {
        deps.ctx
          .logger("hx-memory")
          .warn(
            "background maintenance failed: %s %s",
            record.detail,
            record.output ?? "(no output)",
          );
      } catch {
        // 日志失败不影响宿主
      }
    },
  });
  return { log, loop, available: () => runner.available() !== null, config };
}
