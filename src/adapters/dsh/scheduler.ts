// adapters/dsh/scheduler.ts — P3 后台维护的**策略** (何时跑, 不是怎么跑)。
//
// 补的缺口 (docs/architecture-v2.md §P3 的 ⬜ 调度器): 衰减/TTL 扫描 (`consolidate`) 与
// digest 刷新此前**只有 CLI 能触发** —— 也就是说, 一个只通过面板/D对话使用记忆的用户,
// 永远不会有任何东西被整合。记忆层因此会单调增长: 事件类条目从不衰减, 没人按过 CLI。
//
// 三条设计约束 (每一条都对应一个真实的失败模式):
//
//   1. **空闲窗内才跑, 且一个周期只跑一次。** 维护写的是真相文件 (Markdown), 而宿主随时可能
//      捕获新记忆。策略取保守解: 距离上一次会话活动超过 idleMs 才认为"现在没人写",
//      并且每个闲置周期最多触发一次 —— 否则一次长空闲会反复启动子进程。
//
//   2. **开关与周期都实时读设置。** 面板改动不必重启 (与 episode 保留期同一处理)。
//      周期 0 = 关闭后台维护 (但 CLI 仍可手动跑, 这不冲突)。
//
//   3. **能观测。** 每次尝试都留一条结果 (跑了什么/成功失败/耗时/为什么跳过), 面板与日志可查。
//      维护是"悄悄发生的事" —— 没有这条记录, 用户无法知道它有没有在工作。
//
// 组件拆开是一次**可测性**决策, 而不是分层洁癖: 策略 (Policy) 是纯函数,
// 计时器 (Loop) 是纯调度, 执行 (CliRunner) 是 IO —— 三者里只有最后一项需要真跑子进程。
// 我最初把三者写在一起, 结果"周期 0 不跑"这类断言必须靠真实计时器等待几秒, 又慢又不稳。
/**
 * 维护关心**哪些工作**, 但**不**把它们当 argv 传给 CLI。
 *
 * 区分这两件事是踩过坑之后的分层: CLI 只有一条 `maintain` 命令 (它内部按序做全部工作)。
 * 早期版本把任务名当 argv 传, 于是 `["consolidate", "prune"]` 里的 `prune` 被 CLI 静默忽略
 * (只认第一个位置参数) —— episode 清理从未执行, 而进程 exit 0、记录写"成功"。
 * 现在这个列表只用于**展示与记录** ("这次维护覆盖了什么"), 不参与调用约定。
 */
export type MaintenanceTaskName = "consolidate" | "digest" | "prune" | "relink";

export interface MaintenancePolicyConfig {
  /** 维护周期 (ms); 0 = 关闭。 */
  intervalMs: number;
  /** 空闲多久才认为可以跑 (ms)。 */
  idleMs: number;
  /** 这次维护覆盖的工作面 (仅用于展示/记录; 调用约定见 spawn-cli 的 MAINTENANCE_COMMAND)。 */
  tasks: readonly MaintenanceTaskName[];
}

// relink 也纳入默认维护: 建边只发生在写入时, 因此判据改进后**存量条目会永久落后** ——
// 实测真实库曾出现"可建 401 条边而库里只有 20 条"。靠用户手动跑一次等于缺口长期存在。
// 注: 这个列表只用于**展示与记录**, 真实调用是 CLI 的 maintain 命令 (见本文件头注)。
export const DEFAULT_MAINTENANCE_TASKS: readonly MaintenanceTaskName[] = [
  "consolidate",
  "relink",
  "prune",
];

export interface MaintenanceDecision {
  run: boolean;
  /** 不跑的原因 (可观测; 空串 = 要跑)。 */
  reason: string;
}

/**
 * 判定"现在能不能跑维护" (纯函数: 无计时器、无 IO, 因此可以逐条断言边界)。
 *
 * 两个闸门缺一不可:
 *   - 周期闸门: 距上次**尝试**不足 intervalMs → 不跑 (否则每个 tick 都跑);
 *   - 空闲闸门: 距上次会话活动不足 idleMs → 不跑 (否则会与捕获写入并发改同一批文件)。
 */
export function shouldRunMaintenance(input: {
  now: number;
  lastRunAt: number;
  lastActivityAt: number;
  config: MaintenancePolicyConfig;
}): MaintenanceDecision {
  const { now, lastRunAt, lastActivityAt, config } = input;
  if (config.intervalMs <= 0) return { run: false, reason: "disabled" };
  if (config.tasks.length === 0) return { run: false, reason: "no-tasks" };
  if (now - lastRunAt < config.intervalMs) return { run: false, reason: "interval-not-elapsed" };
  // lastActivityAt === 0 表示"本进程还没有见过任何会话活动": 这不该永远挡住维护
  // (新起的进程从没捕获过东西, 正是最该做一次维护的时候), 因此视为已空闲。
  if (lastActivityAt !== 0 && now - lastActivityAt < config.idleMs) {
    return { run: false, reason: "session-active" };
  }
  return { run: true, reason: "" };
}

/** 一次维护尝试的结果 (面板/日志的读数; 失败也要留痕)。 */
export interface MaintenanceRecord {
  at: string;
  tasks: readonly MaintenanceTaskName[];
  ran: boolean;
  /** 跳过原因 (ran=false 时有值)。 */
  reason: string;
  ok: boolean;
  /** 可读结论 (exit:N / killed:SIGKILL / cli-not-found / 抛出的错误)。 */
  detail: string;
  /** 失败时的子进程输出尾部 —— 只留一个数字不足以排查 (踩过: 记录里只有 "exit:1")。 */
  output?: string;
  elapsedMs: number;
}

export interface MaintenanceLoopOptions {
  /** 当前设置 (实时读取)。 */
  config: () => MaintenancePolicyConfig;
  /** 距离上次会话活动多久了 (ms); 没有活动时返回 0。 */
  idleMs: () => number;
  /** 执行 (注入点: 测试用假实现, 生产用 CLI 子进程)。 */
  execute: () => Promise<{
    ok: boolean;
    detail: string;
    elapsedMs: number;
    /** 失败时的子进程输出尾部 (最好的排查证据; 成功时为空)。 */
    output?: string;
  }>;
  /** 结果回调 (写入环形缓冲供面板展示)。 */
  onRecord?: (record: MaintenanceRecord) => void;
  /** 可注入时钟 (测试确定性)。 */
  now?: () => number;
  /** 检查间隔 (默认 60s): 维护周期通常是小时级, 没必要更密。 */
  tickMs?: number;
  /** 超时 (交给 execute 的实现; 这里只记录)。 */
  timeoutMs?: number;
}

/**
 * 计时器循环。用 `setInterval(...).unref()` —— 它**不得**阻止宿主进程退出
 * (一次性 CLI 场景下, 一个活着的计时器会让命令挂住不返回)。
 */
export class MaintenanceLoop {
  private readonly opts: MaintenanceLoopOptions;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastRunAt = 0;
  private running = false;

  constructor(opts: MaintenanceLoopOptions) {
    this.opts = opts;
    // 与"进程启动时刻"比较: 刚启动时不该立刻跑一次 (那时多半正在加载会话)。
    this.lastRunAt = (opts.now ?? Date.now)();
  }

  start(): void {
    if (this.timer) return;
    const tick = this.opts.tickMs ?? 60_000;
    this.timer = setInterval(() => void this.tick(), tick);
    // unref 是必须的: 否则插件会拖住宿主进程的退出。
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /** 手动跑一次判定 + 执行 (测试与"立即维护"入口共用)。 */
  async tick(): Promise<MaintenanceRecord | null> {
    if (this.running) return null; // 上一次还没跑完: 不许叠加
    const now = (this.opts.now ?? Date.now)();
    const config = this.opts.config();
    const decision = shouldRunMaintenance({
      now,
      lastRunAt: this.lastRunAt,
      // idleMs() 返回 0 表示"从未有过活动"; shouldRunMaintenance 内部按"已空闲"处理。
      lastActivityAt: this.opts.idleMs() > 0 ? now - this.opts.idleMs() : 0,
      config,
    });
    if (!decision.run) return null;
    this.lastRunAt = now;
    this.running = true;
    try {
      const result = await this.opts.execute();
      const record: MaintenanceRecord = {
        at: new Date(now).toISOString(),
        tasks: config.tasks,
        ran: true,
        reason: "",
        ok: result.ok,
        detail: result.detail,
        ...(result.output ? { output: result.output } : {}),
        elapsedMs: result.elapsedMs,
      };
      this.opts.onRecord?.(record);
      return record;
    } catch (error) {
      // execute 的实现承诺不抛, 但策略层也不能因为一个意外的抛出就永远停摆。
      const record: MaintenanceRecord = {
        at: new Date(now).toISOString(),
        tasks: config.tasks,
        ran: true,
        reason: "",
        ok: false,
        detail: String(error),
        elapsedMs: 0,
      };
      this.opts.onRecord?.(record);
      return record;
    } finally {
      this.running = false;
    }
  }
}
