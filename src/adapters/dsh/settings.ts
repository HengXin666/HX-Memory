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
  autoEvolve: z.boolean().default(true),
  semanticWarmupMs: z.natural().min(0).max(2000).default(50),
  captureEpisodes: z.boolean().default(true),
  episodeRetentionDays: z.natural().min(0).max(36500).default(90),
  structurerPrompt: z.string().default(DEFAULT_STRUCTURER_PROMPT),
  abstractorPrompt: z.string().default(DEFAULT_ABSTRACTOR_PROMPT),
});

export type ConfigSchema = typeof Config;
