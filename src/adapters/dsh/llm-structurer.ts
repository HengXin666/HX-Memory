// src/adapters/dsh/llm-structurer.ts — TurnStructurer 的真实 AI 实现。
// 把 turn 交给最小 agent 结构化 (摘要/标签/要点), 失败回退启发式 (由 pipeline 兜底)。
import type { Context } from "@deepseek-ai/cordis";
import type { TurnStructurer, StructuredTurn } from "../../capture/structurer.ts";
import { agentSummarize } from "./llm-agent.ts";

export function makeLlmStructurer(ctx: Context): TurnStructurer {
  return {
    async structure(input) {
      const out = await agentSummarize(ctx, {
        system:
          "你是记忆系统的结构化器。把用户的一句话经验提炼为结构化记忆。\n" +
          "输出严格 JSON (不要其他文字):\n" +
          '{"summary":"一句话摘要","tags":["标签1","标签2"],"points":["要点1","要点2"]}',
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
