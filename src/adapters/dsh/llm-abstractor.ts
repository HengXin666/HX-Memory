// src/adapters/dsh/llm-abstractor.ts — Abstractor 的真实 AI 实现 (VCP 式推广的 AI 参与)。
// 把聚类 (theme + 实例) 交给最小 agent 提炼成跨项目规则提议, 仍过人工闸门。
// 失败/超时/无 agents 服务 → 抛错, 由 GeneralizerService 回退启发式。
import type { Context } from "@deepseek-ai/cordis";
import type { Abstractor } from "../../generalize/service.ts";
import { agentSummarize } from "./llm-agent.ts";

export function makeLlmAbstractor(ctx: Context): Abstractor {
  return {
    async abstract(cluster) {
      const input =
        `主题: ${cluster.theme}\n\n实例 (可能跨项目):\n` +
        cluster.contents.map((c, i) => `${i + 1}. ${c}`).join("\n") +
        `\n\n来源: ${cluster.sources.join(", ")}`;
      const out = await agentSummarize(ctx, {
        system:
          "你是记忆系统的规则提炼器。根据给定的同类实例, 提炼一条跨项目通用规则。\n" +
          "输出严格两行:\n" +
          "RULE: <一条可执行的跨项目规则, 中文, 30字内>\n" +
          "CONFIDENCE: <0-1的小数>\n" +
          "只输出这两行, 不要解释。",
        input,
        timeoutMs: 15000,
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
