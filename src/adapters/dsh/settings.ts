// src/adapters/dsh/settings.ts — HX-Memory 的设置 schema (schemastery)。
import z from "@deepseek-ai/schemastery";
import { DEFAULT_STRUCTURER_PROMPT, DEFAULT_ABSTRACTOR_PROMPT } from "../../prompts.ts";

export const MEMORY_SETTINGS_NAMESPACE = "hx-memory";

export const Config = z.object({
  autoCapture: z.boolean().default(true),
  autoMemoryInterval: z.natural().min(0).max(1000).default(1),
  rootAgentsOnly: z.boolean().default(true),
  language: z.union(["zh", "en"]).default("zh"),
  injectGuidance: z.boolean().default(true),
  injectBindings: z.boolean().default(true),
  // 注入时机: first = 只在会话首轮注入一次 (常驻记忆本来就不变); every-turn = 逐轮差量补新。
  // 为什么是枚举而不是布尔: 它与"注入哪些内容"正交, 将来要加 "on-demand" 时不必再加开关。
  injectMode: z.union(["first", "every-turn"]).default("every-turn"),
  autoEvolve: z.boolean().default(true),
  semanticWarmupMs: z.natural().min(0).max(2000).default(50),
  captureEpisodes: z.boolean().default(true),
  episodeRetentionDays: z.natural().min(0).max(36500).default(90),
  // 注入调度账本: 落盘"为什么注入/为什么没注入", 与捕获开关解耦 (两者是不同的东西)。
  scheduleLog: z.boolean().default(true),
  scheduleLogRetentionDays: z.natural().min(0).max(3650).default(14),
  // 捕获耗时账本: 落盘"这一轮沉淀花了多久、花在哪一段、为什么没沉淀"。
  // 与 scheduleLog 是两条不同的轴 (判定 vs 耗时), 因此是两个开关。
  captureLog: z.boolean().default(true),
  captureRetentionDays: z.natural().min(0).max(3650).default(7),
  // 后台维护: 周期 (小时, 0 = 关闭) + 空闲门槛 (分钟)。两者都实时读 —— 面板改动不必重启。
  maintenanceIntervalHours: z.natural().min(0).max(720).default(6),
  maintenanceIdleMinutes: z.natural().min(0).max(1440).default(10),
  structurerPrompt: z.string().default(DEFAULT_STRUCTURER_PROMPT),
  abstractorPrompt: z.string().default(DEFAULT_ABSTRACTOR_PROMPT),
});

export type ConfigSchema = typeof Config;
