// adapters/dsh/frustration-wiring.ts — 把 src/frustration 的挫折链路接到 DSH 上。
//
// 只做装配: 词表与判官复用 negativity-wiring (设置面板里的词表、判官开关、熔断都沿用),
// 评审模型走 agentSummarize (一次性调用, 独立上下文), 规则落在 <记忆根>/rules/lessons/。
//
// 旧链路怎么处理 (PLAN.md 第 1 节第 3 条「挫折链路合并成一条」):
//   · prestep 的 negativeHint / onNegative / detectNegative: 本链路启用时不再传入 (见 prestep-wiring.ts);
//   · capture 的负面分支 (轮末产出模板教训): 本链路启用时 runtime 拿不到 negativity, 不再产出 (见 index.ts)。
import type { Context } from "@deepseek-ai/cordis";
import { createDetector, FrustrationPipeline, LessonStore, locateWorkspace, recentDiff } from "../../frustration/index.ts";
import { agentSummarize } from "./llm-agent.ts";
import type { NegativityWiring } from "./negativity-wiring.ts";

/** 默认启用; 只有 HX_FRUSTRATION_PIPELINE=0 才关闭。 */
export function frustrationPipelineEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.HX_FRUSTRATION_PIPELINE?.trim() !== "0";
}

/** 评审超时 (ms)。此前 llm-structurer 的 10 s 上限是模板句的主要来源 (EVAL.md C1 的排查提示)。 */
export const REVIEW_TIMEOUT_MS = 60000;

export function createFrustrationPipeline(deps: {
  ctx: Context;
  root: string;
  negativity: NegativityWiring;
  sendReceipt?: (sessionId: string, r: { summary: string; text?: string }) => void;
  logWarn: (message: string, error: unknown) => void;
}): FrustrationPipeline {
  const detector = createDetector({
    compiled: () => deps.negativity.compiled(),
    judge: async (text) => {
      const signal = await deps.negativity.judge(text);
      return signal ? signal.hit : null;
    },
  });
  return new FrustrationPipeline({
    detector,
    store: new LessonStore(deps.root),
    locate: locateWorkspace,
    diff: recentDiff,
    review: (system, input) =>
      agentSummarize(deps.ctx, { task: "frustration-review", system, input, timeoutMs: REVIEW_TIMEOUT_MS, maxTokens: 1024 }),
    onHit: (sessionId, signal) =>
      deps.sendReceipt?.(sessionId, {
        summary: "HX-Memory: 收到纠正 (" + signal.kinds.join("+") + "), 正在同轮评审",
        text: "命中: " + signal.matched.slice(0, 4).join("/") + "。评审结论会在下一个 step 注入, 有证据才入库。",
      }),
    onReviewed: (e) => {
      if (!e.accepted) deps.logWarn("frustration review not stored: %s", e.reason);
    },
  });
}
