// tests/s3/maintenance-replay.test.ts — S3: 后台维护在**真实插件接线**下的行为 (录制→回放)。
//
// 为什么必须走真实接线而不是单元测试: 这个功能的失效模式**全在接线层**。
//   - 计时器是否真的被 start (且 disposer 真的 stop);
//   - 开关/周期是否**实时**读设置 (而不是构造时快照一次);
//   - 执行器是否真的拿到了 --root (漏传 = 每次都跑、每次都没做事);
//   - 维护结果是否真的经 gateway RPC 出得来。
// 上面的每一条都能在单元测试里全绿、同时在真机上一动不动 —— 本仓库真踩过这种假绿
// (entity 通道曾经因为凭据没从组装根转发而恒定零效果, 而通道单测全过)。
//
// 关键: **用真实的 cordis Context**, 不是手搓的假 ctx。
// 原因是本项目真实踩过的坑: gateway 继承 TypertRemoteService, 它在构造时调 `ctx.provide(...)`;
// 假的 ctx 要么缺这个面而报一个与产品无关的错, 要么被"顺手补上"从而让"Service 没挂上"这类
// 真实失效在测试里消失。真 Context 只多花几毫秒, 换来的是"这条路径与真机一致"。
//
// 回放纪律 (见 hx-record-session-replay skill):
//   - 不联网/不起进程: 执行器是假 CLI runner, 只断言接线把它调用到了;
//   - 能失败: 断言钉住的是"会出问题的那一点" (调用次数/间隔/root 参数), 而不是"没抛错";
//   - 帧就是数据: 事件序列与期望副作用都内联在本文件, 回归时可 diff。
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { apply } from "../../src/adapters/dsh/index.ts";
import { DEFAULT_SETTINGS } from "../../src/adapters/dsh/types.ts";
import type { CliRunner } from "../../src/adapters/dsh/spawn-cli.ts";
import { MEMORY_SETTINGS_NAMESPACE } from "../../src/adapters/dsh/settings.ts";

/**
 * 把插件的 apply() 装到一个**真 Context** 上 (含 tools 服务的最小实现: 插件只用它注册工具)。
 * `ctx.plugin(...)` 的返回值是 fork 出来的子 fiber; 卸载它就能验证"disposer 真的清了计时器"。
 */
function mountPlugin(root: string) {
  const ctx = new Context();
  ctx.provide("tools", { register: () => undefined });
  const fiber = ctx.plugin({
    name: "hx-memory-test",
    inject: ["tools"],
    apply: (inner: Context) => apply(inner as never, { root }),
  });
  return { ctx, fiber };
}

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hxmem-replay-"));
});
afterEach(() => {
  delete process.env.HX_MEMORY_CLI;
  rmSync(root, { recursive: true, force: true });
});

/** 假 CLI runner: 记录调用, 不 spawn (回放不联网/不起进程)。 */
function fakeRunner(calls: { tasks: readonly string[]; root: string }[]): CliRunner {
  return {
    available: () => ({ cmd: "node", args: ["fake"] }),
    run: async (o) => {
      // 调用约定里没有任务名 (CLI 只有一条 maintain); 只记录"被调到了, 且 root 正确"。
      calls.push({ tasks: ["maintain"], root: o.root });
      return { ok: true, detail: "exit:0", output: "{}", elapsedMs: 3 };
    },
  };
}

describe("真实 apply() 下的后台维护接线", () => {
  it("装配后的循环真的会把任务交给执行器, 且带上 --root (端到端接线)", async () => {
    // 覆盖两类真实失效: "接线漏了所以永远不跑" 与 "漏传 --root 所以跑了但什么都没做"。
    const calls: { tasks: readonly string[]; root: string }[] = [];
    const { wireMaintenance } = await import("../../src/adapters/dsh/maintenance-wiring.ts");
    const { MaintenanceLog } = await import("../../src/adapters/dsh/maintenance-log.ts");
    const ctx = new Context();
    const log = new MaintenanceLog();
    let clock = 1_000_000;
    const wiring = wireMaintenance({
      ctx: ctx as never,
      root,
      settings: () => ({ ...DEFAULT_SETTINGS, maintenanceIntervalHours: 1 }),
      idleMs: () => 0,
      runner: fakeRunner(calls),
      log,
      now: () => clock,
    });
    // 构造后不立刻跑 (那时多半在加载会话), 越过周期后才跑。
    expect(await wiring.loop.tick()).toBeNull();
    clock += 3_600_001;
    const rec = await wiring.loop.tick();
    expect(rec?.ok).toBe(true);
    expect(calls.length).toBe(1);
    expect(calls[0]?.root).toBe(root);
    // 调用约定是"一条 maintain", 不是任务名数组 (见 spawn-cli 的 MAINTENANCE_COMMAND 说明:
    // 早期把 ["consolidate","prune"] 当 argv 传, 第二个被 CLI 静默忽略, 而进程 exit 0)。
    expect(calls[0]?.tasks).toEqual(["maintain"]);
    expect(log.lastRun()?.ok).toBe(true);
  });

  it("空闲窗挡住执行: 会话刚活动过就不跑 (避免与捕获并发改真相文件)", async () => {
    const calls: { tasks: readonly string[]; root: string }[] = [];
    const { wireMaintenance } = await import("../../src/adapters/dsh/maintenance-wiring.ts");
    const ctx = new Context();
    let clock = 1_000_000;
    const wiring = wireMaintenance({
      ctx: ctx as never,
      root,
      settings: () => ({
        ...DEFAULT_SETTINGS,
        maintenanceIntervalHours: 1,
        maintenanceIdleMinutes: 10,
      }),
      idleMs: () => 60_000, // 1 分钟前刚有会话活动, 门槛 10 分钟
      runner: fakeRunner(calls),
      now: () => clock,
    });
    clock += 3_600_001;
    expect(await wiring.loop.tick()).toBeNull();
    expect(calls.length).toBe(0);
  });

  it("周期 0 = 关闭: 面板改完当轮生效 (不是构造时快照)", async () => {
    const calls: { tasks: readonly string[]; root: string }[] = [];
    const { wireMaintenance } = await import("../../src/adapters/dsh/maintenance-wiring.ts");
    const ctx = new Context();
    let hours = 1;
    let clock = 1_000_000;
    const wiring = wireMaintenance({
      ctx: ctx as never,
      root,
      settings: () => ({ ...DEFAULT_SETTINGS, maintenanceIntervalHours: hours }),
      idleMs: () => 0,
      runner: fakeRunner(calls),
      now: () => clock,
    });
    expect(wiring.config().intervalMs).toBe(3_600_000);
    hours = 0;
    // 同一个实例、不重建: 关掉之后立刻生效 (快照实现会继续显示 1 小时)。
    expect(wiring.config().intervalMs).toBe(0);
    clock += 3_600_001;
    expect(await wiring.loop.tick()).toBeNull();
    expect(calls.length).toBe(0);
  });

  it("找不到 CLI 时如实报告 available=false, 且记录里给出 cli-not-found", async () => {
    const { wireMaintenance } = await import("../../src/adapters/dsh/maintenance-wiring.ts");
    const ctx = new Context();
    const runner: CliRunner = {
      available: () => null,
      run: async () => ({ ok: false, detail: "should-not-be-called", output: "", elapsedMs: 0 }),
    };
    let clock = 1_000_000;
    const wiring = wireMaintenance({
      ctx: ctx as never,
      root,
      settings: () => ({ ...DEFAULT_SETTINGS, maintenanceIntervalHours: 1 }),
      idleMs: () => 0,
      runner,
      now: () => clock,
    });
    expect(wiring.available()).toBe(false);
    clock += 3_600_001;
    const rec = await wiring.loop.tick();
    // 仍在周期上"尝试", 但结论是明确的失败原因, 而不是静默跳过。
    expect(rec?.ok).toBe(false);
    expect(rec?.detail).toBe("cli-not-found");
  });

  it("真 Context 上 apply() 不崩, 且 gateway 的维护 RPC 真挂上了 (Service 真注册)", async () => {
    // 这一条是假 ctx 测不出来的: gateway 继承 TypertRemoteService, 构造即 `ctx.provide`。
    // 用真 Context 就同时钉住了"Service 注册成功"与"maintenance RPC 存在"。
    const { ctx, fiber } = mountPlugin(root);
    await new Promise((r) => setTimeout(r, 0));
    const gateway = (ctx as unknown as { hxMemory?: { maintenance(): unknown } }).hxMemory;
    expect(gateway).toBeTruthy();
    const view = gateway!.maintenance() as {
      enabled: boolean;
      intervalMs: number;
      records: unknown[];
    };
    // 默认开启 (缺口本身就是"默认没人开"造成的, 见 Agent Note § Decision)。
    expect(view.enabled).toBe(true);
    expect(view.intervalMs).toBe(6 * 3_600_000);
    expect(view.records).toEqual([]);
    await fiber.dispose();
  });

  it("设置 schema 接受新增两个键, 且拒绝负周期 (否则会出现恒不触发的配置)", async () => {
    const { Config } = await import("../../src/adapters/dsh/settings.ts");
    expect(MEMORY_SETTINGS_NAMESPACE).toBeTruthy();
    // ⚠ 0.1.7 起这两个字段是 **volatile** (面板可改、改完当轮生效), 解析结果是引用对象
    // `{ get() }` 而不是裸值 —— 宿主 loader 正是靠这个引用做原地更新 (见 settings.ts 顶部)。
    // 所以断言要读 `.get()`, 直接断言数字会得到 "[object Object]" 而失败。
    const parsed = Config({ maintenanceIntervalHours: 3, maintenanceIdleMinutes: 5 }) as {
      maintenanceIntervalHours: { get(): number };
      maintenanceIdleMinutes: { get(): number };
    };
    expect(parsed.maintenanceIntervalHours.get()).toBe(3);
    expect(parsed.maintenanceIdleMinutes.get()).toBe(5);
    expect(() => Config({ maintenanceIntervalHours: -1 })).toThrow();
  });
});
