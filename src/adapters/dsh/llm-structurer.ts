// src/adapters/dsh/llm-structurer.ts — TurnStructurer 的真实 AI 实现。
// 把 turn 交给一次性模型调用结构化 (摘要/标签/要点), 失败回退启发式 (由 pipeline 兜底)。
import type { Context } from "@deepseek-ai/cordis";
import type { TurnStructurer, StructuredTurn } from "../../capture/structurer.ts";
import { agentSummarize } from "./llm-agent.ts";
import { DEFAULT_STRUCTURER_PROMPT, fillTemplate } from "../../prompts.ts";
import type { HxMemorySettings } from "./types.js";

/**
 * 从 LLM 原始输出里**安全取出**两个评分字段。
 *
 * 判据与 `entry-normalize.numberField` 同口径 (接受数字与数字字符串; 越界 clamp)**但有一点不同**:
 * 这里**不抛错** —— LLM 给个坏值不该让整轮捕获失败 (那是增强环节, 不是写入闸门)。
 * 所以坏值 ⇒ **丢弃该字段** (退回中性缺省), 而不是抛。
 */
export function scoringFields(
  parsed: Partial<StructuredTurn>,
): Pick<StructuredTurn, "importance" | "confidence"> {
  const num = (v: unknown): number | undefined => {
    if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
    // 数字字符串是 LLM 的表示差异 (与 numberField 一致); 布尔值**不接受** (§768)。
    if (typeof v === "string" && v.trim() !== "") {
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    }
    return undefined;
  };
  const out: { importance?: number; confidence?: number } = {};
  const imp = num(parsed.importance);
  if (imp !== undefined) out.importance = Math.min(10, Math.max(1, Math.round(imp)));
  const conf = num(parsed.confidence);
  if (conf !== undefined) out.confidence = Math.min(1, Math.max(0, conf));
  return out;
}

/** 创建 AI 结构化器。prompt 缺省用 DEFAULT_STRUCTURER_PROMPT; 用户可在设置面板覆盖。 */
export function makeLlmStructurer(
  ctx: Context,
  settings?: () => Partial<HxMemorySettings>,
): TurnStructurer {
  const prompt = () => settings?.().structurerPrompt?.trim() || DEFAULT_STRUCTURER_PROMPT;
  return {
    // LLM 实现**尝试**产出 conclusion (提示词要求它给结论), 因此具备结论能力 ——
    // 待审闸门据此把"读了但没提炼出结论"判成候选可疑 (那是本机制要拦的那一类)。
    canConclude: true,
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
        // ⚠ **§792 补**: §765 给 `StructuredTurn` 加了 `importance`/`confidence` 并改了提示词,
        // 却**忘了在这里接上** —— 于是字段仍然永不产出 (真库实测 0/480)。
        // 那一刻我只测了 pipeline 的透传 (用假 structurer), 而**没测真实实现**。
        ...scoringFields(parsed),
        ...(entities.length ? { entities } : {}),
        ...(conclusion ? { conclusion } : {}),
      };
    },
  };
}