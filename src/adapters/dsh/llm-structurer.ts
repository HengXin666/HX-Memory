// src/adapters/dsh/llm-structurer.ts — TurnStructurer 的真实 AI 实现。
// 把 turn 交给最小 agent 结构化 (摘要/标签/要点), 失败回退启发式 (由 pipeline 兜底)。
import type { Context } from "@deepseek-ai/cordis";
import type { TurnStructurer, StructuredTurn } from "../../capture/structurer.ts";
import { agentSummarize } from "./llm-agent.ts";
import { DEFAULT_STRUCTURER_PROMPT, fillTemplate } from "../../prompts.ts";
import type { HxMemorySettings } from "./types.js";

/** 创建 AI 结构化器。prompt 缺省用 DEFAULT_STRUCTURER_PROMPT; 用户可在设置面板覆盖。 */
export function makeLlmStructurer(
  ctx: Context,
  settings?: () => Partial<HxMemorySettings>,
): TurnStructurer {
  const prompt = () => settings?.().structurerPrompt?.trim() || DEFAULT_STRUCTURER_PROMPT;
  return {
    async structure(input) {
      const out = await agentSummarize(ctx, {
        task: "structurer",
        system: fillTemplate(prompt(), {}),
        input: input.text,
        timeoutMs: 10000,
      });
      const json = /\{[\s\S]*\}/.exec(out)?.[0];
      if (!json) throw new Error("structurer: no JSON in agent output");
      const parsed = JSON.parse(json) as Partial<StructuredTurn>;
      return {
        summary: parsed.summary ?? input.text,
        tags: Array.isArray(parsed.tags) ? parsed.tags.slice(0, 8) : [],
        points: Array.isArray(parsed.points) ? parsed.points.slice(0, 6) : [],
      };
    },
  };
}
