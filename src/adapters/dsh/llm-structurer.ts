// src/adapters/dsh/llm-structurer.ts — TurnStructurer 的真实 AI 实现。
// 把 turn 交给一次性模型调用结构化 (摘要/标签/要点), 失败回退启发式 (由 pipeline 兜底)。
import type { Context } from "@deepseek-ai/cordis";
import type { TurnStructurer, StructuredTurn } from "../../capture/structurer.ts";
import { agentSummarize } from "./llm-agent.ts";
import { DEFAULT_NEGATIVE_LESSON_PROMPT, DEFAULT_STRUCTURER_PROMPT, fillTemplate } from "../../prompts.ts";
import type { HxMemorySettings } from "./types.js";
// 纯函数部分 (材料排布 / 输出解析 / 评分字段) 在 capture/structurer-io.ts: 回填脚本要在宿主之外复用它们,
// 而本文件经 llm-agent 依赖宿主运行时 (只能在 DSH 进程里加载)。这里原样转出, 调用方不变。
import { parseStructurerOutput, structurerTurnText } from "../../capture/structurer-io.ts";
export { parseStructurerOutput, scoringFields, structurerTurnText } from "../../capture/structurer-io.ts";

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
      const turn = structurerTurnText(input);
      const out = await agentSummarize(ctx, {
        task: isLesson ? "negative-lesson" : "structurer",
        system: fillTemplate(isLesson ? lessonPrompt() : prompt(), { input: turn }),
        input: turn,
        timeoutMs: 10000,
        maxTokens: 1024,
      });
      return parseStructurerOutput(out, input);
    },
  };
}

