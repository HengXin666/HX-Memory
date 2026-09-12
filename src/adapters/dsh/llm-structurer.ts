// src/adapters/dsh/llm-structurer.ts — TurnStructurer 的真实 AI 实现。
// 把 turn 交给一次性模型调用结构化 (摘要/标签/要点), 失败回退启发式 (由 pipeline 兜底)。
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
      // 提示词把 {{input}} 指到"问答对"; 只有问题时就退化成问题本身 (结论闸门已先挡过)。
      const turn = input.answer ? "用户: " + input.text + "\n\n助手: " + input.answer : input.text;
      const out = await agentSummarize(ctx, {
        task: "structurer",
        system: fillTemplate(prompt(), { input: turn }),
        input: turn,
        timeoutMs: 10000,
        maxTokens: 1024,
      });
      const json = /\{[\s\S]*\}/.exec(out)?.[0];
      if (!json) throw new Error("structurer: no JSON in agent output");
      const parsed = JSON.parse(json) as Partial<StructuredTurn>;
      const conclusion = typeof parsed.conclusion === "string" ? parsed.conclusion.trim() : "";
      // 实体做**规范化** (去空白/统一小写比较键, 但保留原形展示), 并去重与限量 ——
      // 实体是建边依据, 同一实体两种写法会让共现匹配失效。
      const rawEntities = Array.isArray(parsed.entities) ? parsed.entities : [];
      const entities: string[] = [];
      const seen = new Set<string>();
      for (const item of rawEntities) {
        if (typeof item !== "string") continue;
        const name = item.trim();
        if (!name || name.length > 40) continue;
        const key = name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        entities.push(name);
        if (entities.length >= 8) break;
      }
      return {
        summary: parsed.summary ?? input.text,
        tags: Array.isArray(parsed.tags) ? parsed.tags.slice(0, 8) : [],
        points: Array.isArray(parsed.points) ? parsed.points.slice(0, 6) : [],
        ...(entities.length ? { entities } : {}),
        ...(conclusion ? { conclusion } : {}),
      };
    },
  };
}