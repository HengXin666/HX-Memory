// tests/s2/decision-port.test.ts — 决策端口: 回退两层、熔断、可用性探测、账本。
//
// ## 为什么这些必须被钉住
//
// 用户的要求是"jev 评判可用性 (可选), 不可用就换, **失败 n 次就不显示**, 记录日志"。
// 这四件事里有三件是**静默**的:
//   · 判官没把握 → 悄悄走既有通道 (用户看不出判官其实没在工作);
//   · 熔断 → 连判官都不调 (用户看不出"为什么行为变回去了");
//   · 落账 → 写不进去只是少几行 (没人会注意到)。
// 所以每一条都需要断言, 否则退化时没有任何信号 —— 而"静默降级"正是这个功能最可能的失败形态。
//
// ## 本文件一律用桩实现, 不打真机
//
// 判官真机 (JEV) 的可用性由 `scripts/smoke-dsh.sh` 与人工探针覆盖。
// 单测若依赖网络, 会在 CI 上变成"时红时绿", 那比不测更坏。
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FallbackController } from "../../src/adapters/decision/fallback.ts";
import { DecisionLog, DECISION_DIR } from "../../src/adapters/decision/decision-log.ts";
import { RecallGate } from "../../src/adapters/decision/recall-gate.ts";
import type {
  DecisionCapabilities,
  DecisionDoctorReport,
  DecisionOutcome,
  DecisionPort,
} from "../../src/kernel/ports-decision.ts";

const CAPS: DecisionCapabilities = {
  name: "stub",
  parallelQuestions: true,
  deterministic: false,
  needsVoting: true,
  latencyClass: "fast",
  costClass: "low",
};

/** 可控桩: 按脚本依次返回结果, 便于构造"连续 n 次失败"。 */
function stubPort(
  scripts: Array<Partial<DecisionOutcome>>,
  opts: { doctorReport?: DecisionDoctorReport; doctorThrows?: boolean } = {},
): DecisionPort & { calls: number } {
  let i = 0;
  const port = {
    name: "stub",
    calls: 0,
    capabilities: () => CAPS,
    async decide(): Promise<DecisionOutcome> {
      const step = scripts[Math.min(i, scripts.length - 1)] ?? { ok: true, agreement: 1 };
      i += 1;
      port.calls += 1;
      return { ok: false, answers: {}, agreement: 0, error: "", ...step };
    },
    async doctor(): Promise<DecisionDoctorReport> {
      if (opts.doctorThrows) throw new Error("boom");
      return opts.doctorReport ?? { ok: true, adapter: "stub" };
    },
  };
  return port as unknown as DecisionPort & { calls: number };
}

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hm-decision-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("回退控制器: 两层语义", () => {
  it("第一层 — 一致度/锐度低 → 升级 (不采信判官)", () => {
    const c = new FallbackController();
    const low = c.route({ ok: true, agreement: 0.2, sharpness: 0.9, error: "" });
    expect(low.usePrimary).toBe(false);
    expect(low.upgraded).toBe(true);
    expect(low.reason).toContain("一致度");

    const blurry = c.route({ ok: true, agreement: 0.99, sharpness: 0.1, error: "" });
    expect(blurry.usePrimary).toBe(false);
    expect(blurry.reason).toContain("锐度");
  });

  it("有把握时采信 (省时间; 不硬升级)", () => {
    const c = new FallbackController();
    const r = c.route({ ok: true, agreement: 0.95, sharpness: 0.8, error: "" });
    expect(r.usePrimary).toBe(true);
    expect(r.upgraded).toBe(false);
  });

  it("第二层 — 连续 n 次升级 → 熔断, 且熔断期内连判官都不调", () => {
    const c = new FallbackController({ policy: { consecutiveUpgrades: 3 } });
    for (let i = 0; i < 2; i += 1) c.route({ ok: true, agreement: 0.1, sharpness: 0.1, error: "" });
    expect(c.circuitOpen(), "2 次还不够, 不该熔断").toBe(false);
    c.route({ ok: true, agreement: 0.1, sharpness: 0.1, error: "" });
    expect(c.circuitOpen(), "第 3 次触发熔断").toBe(true);
    expect(c.status().circuitTrips).toBe(1);
  });

  it("熔断有冷却期; 冷却结束后恢复探测 (半开)", () => {
    let now = 1000;
    const c = new FallbackController({
      policy: { consecutiveUpgrades: 2, cooldownMs: 5000 },
      now: () => now,
    });
    c.route({ ok: true, agreement: 0.1, sharpness: 0.1, error: "" });
    c.route({ ok: true, agreement: 0.1, sharpness: 0.1, error: "" });
    expect(c.circuitOpen()).toBe(true);
    now += 4999;
    expect(c.circuitOpen(), "冷却未到, 仍熔断").toBe(true);
    now += 2;
    expect(c.circuitOpen(), "冷却结束 → 半开, 允许再试").toBe(false);
  });

  it("窗口升级率超阈值也熔断 (不仅是连续计数)", () => {
    // 交替 升级/成功: 连续计数永远归零, 但窗口升级率是 0.5 —— 调低阈值即可触发。
    const c = new FallbackController({
      policy: { consecutiveUpgrades: 99, upgradeRateWindow: 4, upgradeRateMax: 0.4 },
    });
    const up = { ok: true as const, agreement: 0.1, sharpness: 0.1, error: "" };
    const ok = { ok: true as const, agreement: 0.9, sharpness: 0.9, error: "" };
    for (const r of [up, ok, up, ok]) c.route(r);
    expect(c.status().upgradeRate).toBeCloseTo(0.5);
    expect(c.circuitOpen(), "窗口升级率 0.5 > 0.4 → 熔断").toBe(true);
  });

  it("熔断状态落盘, 新实例能读到 (否则每次重启都从头犯错)", () => {
    const dir = join(root, "state");
    const policy = { consecutiveUpgrades: 2, cooldownMs: 600_000 };
    const first = new FallbackController({ policy, persistAs: "g", stateDir: dir, now: () => 1000 });
    first.route({ ok: true, agreement: 0.1, sharpness: 0.1, error: "" });
    first.route({ ok: true, agreement: 0.1, sharpness: 0.1, error: "" });
    expect(first.circuitOpen()).toBe(true);

    const second = new FallbackController({ policy, persistAs: "g", stateDir: dir, now: () => 2000 });
    expect(second.circuitOpen(), "热重载/重启后仍应处于熔断").toBe(true);
    expect(second.status().circuitTrips).toBe(1);
  });

  it("状态文件损坏不致命 (重置而不是崩)", () => {
    const dir = join(root, "state");
    const { mkdirSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "g.json"), "{ not json", "utf8");
    const c = new FallbackController({ persistAs: "g", stateDir: dir });
    expect(c.status().total).toBe(0);
    expect(c.circuitOpen()).toBe(false);
  });
});

describe("召回闸: 判官只能收紧, 不能放宽", () => {
  it("判官说 no → suppress (收紧)", async () => {
    const gate = new RecallGate({
      port: stubPort([{ ok: true, agreement: 0.9, sharpness: 0.8, answers: { recall: { type: "choice", choice: "no" } } }]),
    });
    const r = await gate.judge("兼容一下新版本 dsh", { count: 9, sample: ["[rule] 派生索引必须可全量重建"] });
    expect(r.consulted).toBe(true);
    expect(r.suppress).toBe(true);
  });

  it("判官说 yes → 不 suppress, 且**不额外放宽** (保持既有行为)", async () => {
    const gate = new RecallGate({
      port: stubPort([{ ok: true, agreement: 0.9, sharpness: 0.8, answers: { recall: { type: "choice", choice: "yes" } } }]),
    });
    const r = await gate.judge("派生索引为什么这么定?", { count: 9, sample: ["候选"] });
    expect(r.consulted).toBe(true);
    expect(r.suppress).toBe(false);
  });

  it("没有实现 → 与没有这层完全一致 (不抛错、不抑制)", async () => {
    const gate = new RecallGate({});
    const r = await gate.judge("随便问问", { count: 3, sample: ["候选"] });
    expect(r.suppress).toBe(false);
    expect(r.consulted).toBe(false);
  });

  it("空输入 / 无候选 → 不浪费一次判官调用", async () => {
    const port = stubPort([{ ok: true, agreement: 1 }]);
    const gate = new RecallGate({ port });
    await gate.judge("", { count: 3, sample: ["候选"] });
    await gate.judge("有输入", { count: 0, sample: [] });
    expect(port.calls, "两次都不该调判官").toBe(0);
  });
});

describe("召回闸: 不可用就换 (三种降级路径)", () => {
  it("判官连续没把握 → 升级为既有通道 (consulted=false)", async () => {
    const gate = new RecallGate({
      port: stubPort([{ ok: true, agreement: 0.1, sharpness: 0.1 }]),
    });
    const r = await gate.judge("问题", { count: 3, sample: ["候选"] });
    expect(r.consulted).toBe(false);
    expect(r.suppress, "降级绝不能变成抑制 —— 否则记忆静默消失").toBe(false);
    expect(r.reason).toContain("升级");
  });

  it("判官报错 → 走既有通道, 且连续 n 次后熔断 (两种失败都算)", async () => {
    const gate = new RecallGate({
      port: stubPort([{ ok: false, error: "upstream_500" }]),
      policy: { consecutiveUpgrades: 3 },
    });
    for (let i = 0; i < 3; i += 1) await gate.judge("问题", { count: 3, sample: ["候选"] });
    expect(gate.status().circuitOpen, "报错也计入熔断").toBe(true);
  });

  it("熔断后**连判官都不调** (这才是'失败 n 次就不显示')", async () => {
    const port = stubPort([{ ok: true, agreement: 0.1, sharpness: 0.1 }]);
    const gate = new RecallGate({ port, policy: { consecutiveUpgrades: 2 } });
    await gate.judge("a", { count: 3, sample: ["c"] });
    await gate.judge("b", { count: 3, sample: ["c"] });
    expect(gate.status().circuitOpen).toBe(true);
    const before = port.calls;
    const r = await gate.judge("c", { count: 3, sample: ["c"] });
    expect(port.calls, "熔断期不该再起子进程").toBe(before);
    expect(r.consulted).toBe(false);
    expect(r.reason).toContain("熔断");
  });
});

describe("可用性探测 (doctor): 配置缺失与调用层故障要分开", () => {
  it("探测不通过且原因是 no_key → 配置缺失 ⇒ 直接跳过调用 (耗时 0)", async () => {
    const port = stubPort([{ ok: true, agreement: 1 }], {
      doctorReport: { ok: false, adapter: "stub", error: "no_key" },
    });
    const gate = new RecallGate({ port });
    await gate.probe();
    expect(gate.probeStatus().verdict).toBe("missing-config");
    const r = await gate.judge("问题", { count: 3, sample: ["候选"] });
    expect(port.calls, "配置缺失时不该白花一次调用").toBe(0);
    expect(r.consulted).toBe(false);
  });

  it("探测不通过且原因是上游故障 → 交给回退统计 (可能自愈, 不直接跳过)", async () => {
    const port = stubPort([{ ok: true, agreement: 0.9, sharpness: 0.9 }], {
      doctorReport: { ok: false, adapter: "stub", error: "upstream_503" },
    });
    const gate = new RecallGate({ port });
    await gate.probe();
    expect(gate.probeStatus().verdict).toBe("error");
    await gate.judge("问题", { count: 3, sample: ["候选"] });
    expect(port.calls, "调用层故障仍应尝试 (可能已恢复)").toBe(1);
  });

  it("探测通过 → 正常判定", async () => {
    const gate = new RecallGate({ port: stubPort([{ ok: true, agreement: 0.9, sharpness: 0.8, answers: { recall: { type: "choice", choice: "no" } } }]) });
    await gate.probe();
    expect(gate.probeStatus().verdict).toBe("ok");
    expect((await gate.judge("q", { count: 1, sample: ["c"] })).consulted).toBe(true);
  });

  it("doctor 抛错不致命 (探测不该拖垮插件)", async () => {
    const gate = new RecallGate({ port: stubPort([{ ok: true, agreement: 1 }], { doctorThrows: true }) });
    await expect(gate.probe()).resolves.toBeNull();
    expect(gate.probeStatus().verdict).toBe("error");
  });

  it("实现没有 doctor 能力 → 视为无法预检, 但不阻塞", async () => {
    const port: DecisionPort = {
      name: "no-doctor",
      capabilities: () => CAPS,
      async decide() {
        return { ok: true, answers: {}, agreement: 1, error: "" };
      },
    };
    const gate = new RecallGate({ port });
    expect(await gate.probe()).toBeNull();
    expect(gate.probeStatus().verdict).toBe("ok");
  });
});

describe("决策账本: 熔断/降级必须可查", () => {
  it("每次决策落一条, outcome 四态可区分", async () => {
    const log = new DecisionLog({ root });
    const gate = new RecallGate({
      port: stubPort([
        { ok: true, agreement: 0.9, sharpness: 0.9, answers: { recall: { type: "choice", choice: "yes" } } },
        { ok: true, agreement: 0.1, sharpness: 0.1 },
        { ok: false, error: "boom" },
      ]),
      log,
    });
    await gate.judge("a", { count: 1, sample: ["c"] });
    await gate.judge("b", { count: 1, sample: ["c"] });
    await gate.judge("c", { count: 1, sample: ["c"] });
    const s = log.summary();
    expect(s.byOutcome.used).toBe(1);
    expect(s.byOutcome.upgraded).toBe(1);
    expect(s.byOutcome.error).toBe(1);
    expect(s.degradedRate).toBeCloseTo(2 / 3);
    expect(s.unavailable).toBe(1);
  });

  it("落盘到 <root>/decision-log, 且记录带时间戳 (时间只有一个来源)", async () => {
    const log = new DecisionLog({ root });
    log.append({ purpose: "recall-gate", adapter: "stub", outcome: "used" }, "2026-01-02T03:04:05.000Z");
    const rows = log.recent();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.at).toBe("2026-01-02T03:04:05.000Z");
    expect(DECISION_DIR).toBe("decision-log");
  });

  it("坏行不让整份不可读 (跳过它, 其余照读)", async () => {
    const { writeFileSync, mkdirSync } = require("node:fs") as typeof import("node:fs");
    const dir = join(root, DECISION_DIR);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "2026-01-02.jsonl"), '{"at":"x","purpose":"p","adapter":"a","outcome":"used"}\n{ broken\n', "utf8");
    const log = new DecisionLog({ root });
    expect(log.recent()).toHaveLength(1);
  });

  it("不传 log 时判定照常工作 (落账是可选的可观测面, 不是功能依赖)", async () => {
    const gate = new RecallGate({ port: stubPort([{ ok: true, agreement: 0.9, sharpness: 0.9, answers: { recall: { type: "choice", choice: "no" } } }]) });
    const r = await gate.judge("q", { count: 1, sample: ["c"] });
    expect(r.suppress).toBe(true);
  });
});
