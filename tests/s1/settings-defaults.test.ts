// tests/s1/settings-defaults.test.ts — 用户可见的默认配置必须有测试钉住。
//
// 为什么需要它 (2026-09-18 变异测试发现): 把 `DEFAULT_CAPTURE_RETENTION_DAYS` 从 7 改成 999,
// 把 `DEFAULT_MAINTENANCE_HISTORY` 从 20 改成 0, **全量测试都通过** —— 即这些默认值
// **没有任何测试保护**。
//
// 它们与检索常量 (见 tuning-constants.test.ts) 的区别:
//   · 检索常量改坏了 → **检索质量静默退化** (看不见);
//   · 配置默认值改坏了 → **用户可见行为变化**: 账本保留期、面板历史条数、注入时机……
//     这些是"新装的用户会得到什么"的定义, 而且**它们真的流到行为**:
//     `retentionDays: config.retentionDays ?? DEFAULT_CAPTURE_RETENTION_DAYS`。
//
// **不测的部分 (如实记录)**: `entityMaxIds` 经 60 查询采样**完全无影响** (0/60 不一致),
// 因此没有为它加防护 —— 加一个测不出差别的断言只是噪音。
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../../src/adapters/dsh/types.ts";
import { DEFAULT_MAINTENANCE_HISTORY } from "../../src/adapters/dsh/maintenance-log.ts";
import { DEFAULT_CAPTURE_MAX_LINES } from "../../src/adapters/dsh/capture-log.ts";
import { DEFAULT_SCHEDULE_MAX_LINES } from "../../src/adapters/dsh/schedule-log.ts";

describe("用户可见的默认配置", () => {
  it("**注入与捕获的开关默认开启** (关了就等于记忆层不存在)", () => {
    // 这些开关决定"装完就能用"还是"装完什么都不发生"。
    expect(DEFAULT_SETTINGS.autoCapture).toBe(true);
    expect(DEFAULT_SETTINGS.captureEpisodes).toBe(true);
    expect(DEFAULT_SETTINGS.autoEvolve).toBe(true);
    expect(DEFAULT_SETTINGS.injectGuidance).toBe(true);
    expect(DEFAULT_SETTINGS.injectBindings).toBe(true);
    expect(DEFAULT_SETTINGS.scheduleLog).toBe(true);
    expect(DEFAULT_SETTINGS.captureLog).toBe(true);
  });

  it("**注入时机默认 every-turn** (改它等于改用户最直接的体验)", () => {
    // 用户曾明确要求"至少给个开关", 而默认值是产品判断的结果:
    // every-turn 的滞后最小, 代价是每轮都注入 (那正是"注入去重"要处理的问题)。
    expect(DEFAULT_SETTINGS.injectMode).toBe("every-turn");
  });

  it("**保留期是刻意的短**: episode 90 天 / 调度 14 天 / 捕获 7 天", () => {
    // 为什么捕获账本只有 7 天: 它是**性能观测**, 不是重放输入 (见 capture-log.ts 的注释)。
    // 调度 14 天比捕获长, 因为"为什么这一轮没注入"的排查窗口更长。
    // 这条断言的价值: 这三个数字的**相对关系**是有理由的, 改动必须是自觉的。
    expect(DEFAULT_SETTINGS.episodeRetentionDays).toBe(90);
    expect(DEFAULT_SETTINGS.scheduleLogRetentionDays).toBe(14);
    expect(DEFAULT_SETTINGS.captureRetentionDays).toBe(7);
    expect(DEFAULT_SETTINGS.episodeRetentionDays).toBeGreaterThan(DEFAULT_SETTINGS.scheduleLogRetentionDays);
    expect(DEFAULT_SETTINGS.scheduleLogRetentionDays).toBeGreaterThan(DEFAULT_SETTINGS.captureRetentionDays);
  });

  it("账本行数上限与面板历史条数 (容量护栏)", () => {
    // 行数上限是"账本不许长成拖垮宿主的东西"的落实; 历史条数是面板一次显示多少条。
    expect(DEFAULT_CAPTURE_MAX_LINES).toBe(4000);
    expect(DEFAULT_SCHEDULE_MAX_LINES).toBe(2000);
    expect(DEFAULT_MAINTENANCE_HISTORY).toBe(20);
  });

  it("维护周期与空闲阈值", () => {
    // 维护只在空闲窗内跑 —— 这两个值决定"多久检查一次"与"闲多久才算闲"。
    expect(DEFAULT_SETTINGS.maintenanceIntervalHours).toBe(6);
    expect(DEFAULT_SETTINGS.maintenanceIdleMinutes).toBe(10);
  });
});
