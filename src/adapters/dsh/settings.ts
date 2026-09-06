// src/adapters/dsh/settings.ts — HX-Memory 的设置 schema (schemastery)。
import z from "@deepseek-ai/schemastery";

export const MEMORY_SETTINGS_NAMESPACE = "hx-memory";

export const Config = z.object({
  autoCapture: z.boolean().default(true),
  autoMemoryInterval: z.natural().min(0).max(1000).default(5),
  rootAgentsOnly: z.boolean().default(true),
  language: z.union(["zh", "en"]).default("zh"),
  injectGuidance: z.boolean().default(true),
});

export type ConfigSchema = typeof Config;
