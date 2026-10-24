// src/adapters/dsh/llm-structurer.ts — TurnStructurer 的真实 AI 实现。
// 把 turn 交给一次性模型调用结构化 (摘要/标签/要点), 失败回退启发式 (由 pipeline 兜底)。
import type { Context } from "@deepseek-ai/cordis";
import type { TurnStructurer, StructuredTurn } from "../../capture/structurer.ts";
import { agentSummarize } from "./llm-agent.ts";
import { DEFAULT_NEGATIVE_LESSON_PROMPT, DEFAULT_STRUCTURER_PROMPT, fillTemplate } from "../../prompts.ts";
import type { HxMemorySettings } from "./types.js";

/**
 * 从 LLM 原始输出里**安全取出**两个评分字段。
 *
 * 判据与 `entry-normalize.numberField` 同口径 (接受数字与数字字符串; 越界 clamp)**但有一点不同**:
 * 这里**不抛错**  LLM 给个坏值不该让整轮捕获失败 (那是增强环节, 不是写入闸门)。
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
  // 负面轮次的提示词 (见 DEFAULT_NEGATIVE_LESSON_PROMPT 的说明: 问题不同, 不能共用一份)。
  const lessonPrompt = () => settings?.().negativeLessonPrompt?.trim() || DEFAULT_NEGATIVE_LESSON_PROMPT;
  return {
    // LLM 实现**尝试**产出 conclusion (提示词要求它给结论), 因此具备结论能力 
    // 待审闸门据此把"读了但没提炼出结论"判成候选可疑 (那是本机制要拦的那一类)。
    canConclude: true,
    async structure(input) {
      // 提示词把 {{input}} 指到"问答对"; 只有问题时就退化成问题本身 (结论闸门已先挡过)。
      //
      // ⚠ 负面轮次的**材料形态不同** (2026-10-06, 用户实测: "我骂你的时候显然不会直接告诉你答案,
      // 肯定要看你的上下文"): 那时 `input.text` 是**已经生成好的教训模板** (来自 lessonDraftOf),
      // 而**真正的信息在 `input.agentOutput`** (agent 上一轮到底输出了什么, 才招来那句批评)。
      // 若沿用"用户: {模板}\n助手: {回答}"的排布, 提炼器看到的是一句泛泛禁令 + 一段与它无关的输出,
      // 只能再吐出一句泛泛禁令  那正是"沉淀了但没内容"的成因。
      // 负面轮次走**全量上下文** (用户实测: "要有全量上下文…缓存是基于前缀的"):
      // 材料是整段对话流 (见 capture/transcript.ts), 而不是只有那句批评。
      // 没有 transcript 时, `input.text` 本身已含被否决的原话 (engine 的证据行), 够用。
      const isLesson = Boolean(input.transcript);
      const turn = isLesson
        ? [
            input.transcript ?? "",
            "",
            "以上是到目前为止的完整对话。最后那条用户消息就是批评;",
            "结合你在它之前做的事, 说清你具体做错了什么。",
          ].join("\n")
        : input.answer
          ? "用户: " + input.text + "\n\n助手: " + input.answer
          : input.text;
      const out = await agentSummarize(ctx, {
        task: isLesson ? "negative-lesson" : "structurer",
        system: fillTemplate(isLesson ? lessonPrompt() : prompt(), { input: turn }),
        input: turn,
        timeoutMs: 10000,
        maxTokens: 1024,
      });
      const json = /\{[\s\S]*\}/.exec(out)?.[0];
      if (!json) throw new Error("structurer: no JSON in agent output");
      const parsed = JSON.parse(json) as Partial<StructuredTurn>;
      const conclusion = typeof parsed.conclusion === "string" ? parsed.conclusion.trim() : "";
      // 实体做**规范化** (去空白/统一小写比较键, 但保留原形展示), 并去重与限量 
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
        // 却**忘了在这里接上**  于是字段仍然永不产出 (真库实测 0/480)。
        // 那一刻我只测了 pipeline 的透传 (用假 structurer), 而**没测真实实现**。
        ...scoringFields(parsed),
        ...(entities.length ? { entities } : {}),
        ...(conclusion ? { conclusion } : {}),
      };
    },
  };
}