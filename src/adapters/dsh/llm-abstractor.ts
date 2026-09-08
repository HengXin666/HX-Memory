// src/adapters/dsh/llm-abstractor.ts — Abstractor 的真实 AI 实现 (VCP 式推广的 AI 参与)。
// 把聚类 (theme + 实例) 交给一次性模型调用提炼成跨项目规则提议, 仍过人工闸门。
// 失败/超时/无 llm 服务 → 抛错, 由 GeneralizerService 回退启发式。
import type { Context } from "@deepseek-ai/cordis";
import type { Abstractor } from "../../generalize/service.ts";
import { agentSummarize } from "./llm-agent.ts";
import { DEFAULT_ABSTRACTOR_PROMPT, fillTemplate } from "../../prompts.ts";
import type { HxMemorySettings } from "./types.js";

/** 创建 AI 抽象器。prompt 缺省用 DEFAULT_ABSTRACTOR_PROMPT; 用户可在设置面板覆盖。 */
export function makeLlmAbstractor(
  ctx: Context,
  settings?: () => Partial<HxMemorySettings>,
): Abstractor {
  const prompt = () => settings?.().abstractorPrompt?.trim() || DEFAULT_ABSTRACTOR_PROMPT;
  return {
    async abstract(cluster) {
      const input =
        `主题: ${cluster.theme}\n\n实例 (可能跨项目):\n` +
        cluster.contents.map((c, i) => `${i + 1}. ${c}`).join("\n") +
        `\n\n来源: ${cluster.sources.join(", ")}`;
      const out = await agentSummarize(ctx, {
        task: "abstractor",
        system: fillTemplate(prompt(), { theme: cluster.theme }),
        input,
        timeoutMs: 15000,
        maxTokens: 1024,
      });
      const rule = /RULE:\s*(.+)/i.exec(out)?.[1]?.trim();
      const conf = /CONFIDENCE:\s*(\d+(?:\.\d+)?)/i.exec(out)?.[1];
      if (!rule) throw new Error("abstractor: no RULE in agent output");
      return {
        rule,
        confidence: conf ? Math.min(1, Math.max(0, parseFloat(conf))) : 0.5,
      };
    },
  };
}
