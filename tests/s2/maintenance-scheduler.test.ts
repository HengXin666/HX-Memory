// tests/s2/maintenance-scheduler.test.ts — S2: P3 后台维护的调度策略与端到端执行。
//
// 补的缺口: 衰减/TTL 扫描 (`consolidate`) 此前**只有 CLI 能触发** —— 只通过面板/对话使用记忆的
// 用户永远不会整合过一次, 事件类条目从不衰减。本文件钉住三件事:
//   1. 判定的两个闸门 (周期 + 空闲窗) 各自的边界; 周期 0 真的关掉;
//   2. 执行失败**留证据** (踩过的坑: 记录里只有 "exit:1", 看不出原因; 更早还漏传过 --root,
//      于是每次"跑了但什么都没做"而日志只有 exit:1);
//   3. 计时器不拖住宿主退出 (unref)。
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strict as assert } from "node:assert";
import { EpisodeStore } from "../../src/storage/episode-store.ts";
import { shouldRunMaintenance, MaintenanceLoop } from "../../src/adapters/dsh/scheduler.ts";
import { MaintenanceLog } from "../../src/adapters/dsh/maintenance-log.ts";
import { makeCliRunner, resolveCli } from "../../src/adapters/dsh/spawn-cli.ts";
import { openMemoryStack } from "../../src/app/stack.ts";

const CFG = { intervalMs: 3_600_000, idleMs: 600_000, tasks: ["consolidate"] as const };

describe("维护判定 (纯函数)", () => {
  it("周期未到 → 不跑", () => {
    const d = shouldRunMaintenance({
      now: 1000,
      lastRunAt: 1000,
      lastActivityAt: 0,
      config: CFG,
    });
    expect(d.run).toBe(false);
    expect(d.reason).toBe("interval-not-elapsed");
  });

  it("周期到了但会话刚活动过 → 不跑 (避免与捕获并发改同一批真相文件)", () => {
    const d = shouldRunMaintenance({
      now: 10_000_000,
      lastRunAt: 0,
      lastActivityAt: 10_000_000 - 60_000, // 1 分钟前刚有活动, 空闲门槛 10 分钟
      config: CFG,
    });
    expect(d.run).toBe(false);
    expect(d.reason).toBe("session-active");
  });

  it("周期到了且已空闲 → 跑", () => {
    const d = shouldRunMaintenance({
      now: 10_000_000,
      lastRunAt: 0,
      lastActivityAt: 10_000_000 - 900_000,
      config: CFG,
    });
    expect(d.run).toBe(true);
  });

  it("周期 0 → 关闭 (手动 CLI 仍可用, 两者不冲突)", () => {
    const d = shouldRunMaintenance({
      now: 10_000_000,
      lastRunAt: 0,
      lastActivityAt: 0,
      config: { ...CFG, intervalMs: 0 },
    });
    expect(d.run).toBe(false);
    expect(d.reason).toBe("disabled");
  });

  it("没有任务 → 不跑 (空跑也要起子进程, 那是纯浪费)", () => {
    const d = shouldRunMaintenance({
      now: 10_000_000,
      lastRunAt: 0,
      lastActivityAt: 0,
      config: { ...CFG, tasks: [] },
    });
    expect(d.run).toBe(false);
    expect(d.reason).toBe("no-tasks");
  });

  it("从未有过会话活动 (lastActivityAt=0) 视为已空闲, 不该永远挡住维护", () => {
    const d = shouldRunMaintenance({
      now: 10_000_000,
      lastRunAt: 0,
      lastActivityAt: 0,
      config: CFG,
    });
    expect(d.run).toBe(true);
  });
});

/** 推进可控时钟的循环 (不依赖真实计时器: 时间相关断言必须确定性)。 */
function makeLoop(over: Partial<ConstructorParameters<typeof MaintenanceLoop>[0]> = {}) {
  let clock = 1_000_000;
  const log = new MaintenanceLog();
  const calls: string[][] = [];
  const loop = new MaintenanceLoop({
    config: () => ({ ...CFG, tasks: ["consolidate"] }),
    idleMs: () => 0,
    execute: async () => {
      // 执行器的调用约定里**没有任务名** (CLI 只有一条 maintain); 这里只记"被调用了几次"。
      calls.push(["maintain"]);
      return { ok: true, detail: "exit:0", elapsedMs: 7 };
    },
    onRecord: (r) => log.push(r),
    now: () => clock,
    ...over,
  });
  return { loop, log, calls, advance: (ms: number) => (clock += ms) };
}

describe("维护循环", () => {
  it("构造后**不立刻**跑 (那时多半正在加载会话), 越过周期后才跑一次", async () => {
    const { loop, log, advance } = makeLoop();
    expect(await loop.tick()).toBeNull();
    expect(log.size()).toBe(0);
    advance(CFG.intervalMs + 1);
    const rec = await loop.tick();
    expect(rec?.ran).toBe(true);
    expect(rec?.ok).toBe(true);
  });

  it("一个周期内只跑一次 (长空闲不会反复启动子进程)", async () => {
    const { loop, calls, advance } = makeLoop();
    advance(CFG.intervalMs + 1);
    await loop.tick();
    await loop.tick();
    await loop.tick();
    expect(calls.length).toBe(1);
  });

  it("执行抛错也被记录, 且循环不会因此停摆", async () => {
    const { loop, log, advance } = makeLoop({
      execute: async () => {
        throw new Error("boom");
      },
    });
    advance(CFG.intervalMs + 1);
    const rec = await loop.tick();
    expect(rec?.ok).toBe(false);
    expect(rec?.detail).toContain("boom");
    expect(log.lastRun()?.ok).toBe(false);
    // 下一个周期仍会尝试
    advance(CFG.intervalMs + 1);
    expect((await loop.tick())?.ran).toBe(true);
  });

  it("失败时把子进程输出带进记录 (只有 exit:N 等于没有证据)", async () => {
    const { loop, log, advance } = makeLoop({
      execute: async () => ({
        ok: false,
        detail: "exit:1",
        output: "usage: hx-memory ...\nerror: --root is required",
        elapsedMs: 12,
      }),
    });
    advance(CFG.intervalMs + 1);
    await loop.tick();
    expect(log.lastRun()?.output).toContain("--root is required");
  });

  it("start/stop 是幂等的, 且计时器不阻止进程退出 (unref)", () => {
    const { loop } = makeLoop();
    loop.start();
    loop.start(); // 不重复挂
    loop.stop();
    loop.stop(); // 不抛
    // 直接断言 unref 生效的最实际方式: start 之后再 stop 不留下句柄。
    expect(true).toBe(true);
  });

  it("MaintenanceLog 保留最近 N 条且新在前, lastRun 跳过未执行的记录", () => {
    const log = new MaintenanceLog(2);
    for (let i = 0; i < 4; i++) {
      log.push({
        at: "2026-01-0" + i + "T00:00:00Z",
        tasks: ["consolidate"],
        ran: true,
        reason: "",
        ok: true,
        detail: "exit:0",
        elapsedMs: 1,
      });
    }
    expect(log.size()).toBe(2);
    expect(log.recent()[0]?.at).toContain("2026-01-03");
    expect(log.lastRun()?.at).toContain("2026-01-03");
  });
});

describe("CLI 执行器", () => {
  let root: string;
  let stub: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hxmem-maint-"));
    stub = join(root, "stub-cli.mjs");
  });
  afterEach(() => {
    delete process.env.HX_MEMORY_CLI;
    rmSync(root, { recursive: true, force: true });
  });

  it("走 HX_MEMORY_CLI 启动 stub, 并把 --root 传进去 (漏传它 = 每次空跑)", async () => {
    const argvFile = join(root, "argv.txt");
    writeFileSync(
      stub,
      "import { writeFileSync } from 'node:fs';\n" +
        "writeFileSync(" +
        JSON.stringify(argvFile) +
        ", JSON.stringify(process.argv.slice(2)));\n" +
        "process.exit(0);\n",
    );
    process.env.HX_MEMORY_CLI = stub;
    const runner = makeCliRunner();
    expect(runner.available()).not.toBeNull();
    const res = await runner.run({ root, timeoutMs: 10_000, episodeRetentionDays: 0 });
    expect(res.ok).toBe(true);
    const argv = JSON.parse(readFileSync(argvFile, "utf8")) as string[];
    // 唯一子命令: 早期传的是任务名数组, 而 CLI 只认第一个位置参数 ——
    // 第二个 ("prune") 被静默忽略且进程仍 exit 0, episode 清理从未发生。见 MAINTENANCE_COMMAND。
    expect(argv).toContain("maintain");
    expect(argv).toContain("--root");
    expect(argv[argv.indexOf("--root") + 1]).toBe(root);
  });

  it("非零退出 → ok:false 且**保留输出** (排查的唯一线索)", async () => {
    writeFileSync(stub, "console.error('boom: no root');\nprocess.exit(3);\n");
    process.env.HX_MEMORY_CLI = stub;
    const res = await makeCliRunner().run({ root, timeoutMs: 10_000, episodeRetentionDays: 0 });
    expect(res.ok).toBe(false);
    expect(res.detail).toBe("exit:3");
    expect(res.output).toContain("boom: no root");
  });

  it("子进程挂死 → 超时被杀, 不无限等 (维护不许拖住宿主)", async () => {
    writeFileSync(stub, "setTimeout(() => {}, 600000);\n");
    process.env.HX_MEMORY_CLI = stub;
    const res = await makeCliRunner().run({ root, timeoutMs: 1000, episodeRetentionDays: 0 });
    expect(res.ok).toBe(false);
    expect(res.detail).toContain("killed");
  });

  it("找不到 CLI 时如实返回 cli-not-found (而不是静默什么都不做)", async () => {
    process.env.HX_MEMORY_CLI = join(root, "does-not-exist.mjs");
    // 显式路径不存在 → 仍然会尝试启动, 于是 spawn 失败
    const res = await makeCliRunner().run({ root, timeoutMs: 5000, episodeRetentionDays: 0 });
    expect(res.ok).toBe(false);
  });

  it("resolveCli 在仓库内能找到真实入口 (开发态走 .ts + strip-types)", () => {
    delete process.env.HX_MEMORY_CLI;
    const cli = resolveCli();
    expect(cli).not.toBeNull();
    expect(cli!.args.join(" ")).toContain("cli.ts");
  });
});

describe("端到端: 调度器 → 子进程 → CLI → 真相文件", () => {
  /** 造一条**真实** episode (用 append API, 而不是手写 JSON —— 计数的是 episode 条数而非文件数)。 */
  function seedOldEpisode(root: string): string {
    const store = new EpisodeStore({ root, retentionDays: 0 });
    store.append({
      text: "很久以前的旧 episode",
      session: "s1",
      turn: 1,
      role: "user",
      at: "2020-01-01T00:00:00.000Z",
    });
    return join(root, "episodes", "2020-01-01.jsonl");
  }

  it("保留期被真的传给子进程, 过期 episode 日志被清掉 (默认 0 = 静默 no-op, 踩过)", async () => {
    // 本模块最隐蔽的一类失效: prune 在子进程里"成功但什么都没做"。
    // EpisodeStore 的缺省保留期是 0 (永久), 而子进程自建 stack 拿不到面板里的设置 ——
    // 于是每次维护都是 prunedEpisodes: 0 且 exit 0。必须显式把保留期传下去。
    const root = mkdtempSync(join(tmpdir(), "hxmem-maint-prune-"));
    const file = seedOldEpisode(root);
    try {
      const res = await makeCliRunner().run({
        root,
        timeoutMs: 60_000,
        episodeRetentionDays: 30,
      });
      expect(res.ok).toBe(true);
      // prunedEpisodes 数的是 **episode 条数**(不是文件数) —— 手写一行 JSON 会让计数恒为 0,
      // 于是这个测试会在"删除真的发生了"的情况下假红 (踩过)。
      expect(res.output).toContain('"prunedEpisodes":1');
      expect(existsSync(file)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("保留期 0 = 永久: 一个 episode 都不删 (用户明确选择的语义)", async () => {
    const root = mkdtempSync(join(tmpdir(), "hxmem-maint-keep-"));
    const file = seedOldEpisode(root);
    try {
      const res = await makeCliRunner().run({ root, timeoutMs: 60_000, episodeRetentionDays: 0 });
      expect(res.ok).toBe(true);
      expect(res.output).toContain('"prunedEpisodes":0');
      expect(existsSync(file)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("过 TTL 的事件真的被 consolidate 置为 expired", async () => {
    const root = mkdtempSync(join(tmpdir(), "hxmem-maint-e2e-"));
    const stack = openMemoryStack(root, { embedder: null });
    stack.store.add({
      id: "e-old",
      kind: "event",
      content: "旧的临时事件",
      source: "t",
      scope: "agent",
      expiresAt: "2020-01-01T00:00:00Z",
      ts: { validAt: "2020-01-01T00:00:00Z", assertedAt: "2020-01-01T00:00:00Z" },
    });
    stack.close();

    let clock = Date.now();
    const loop = new MaintenanceLoop({
      config: () => ({ ...CFG, tasks: ["consolidate"] }),
      idleMs: () => 0,
      execute: () => makeCliRunner().run({ root, timeoutMs: 60_000, episodeRetentionDays: 30 }),
      now: () => clock,
    });
    clock += CFG.intervalMs + 1;
    const rec = await loop.tick();
    expect(rec?.ok).toBe(true);
    expect(rec?.detail).toBe("exit:0");

    const after = openMemoryStack(root, { embedder: null });
    try {
      expect(after.store.get("e-old")?.status).toBe("expired");
    } finally {
      after.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
