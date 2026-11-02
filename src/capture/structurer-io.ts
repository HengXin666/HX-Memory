// capture/structurer-io.ts — LLM 结构化器的纯函数部分 (材料排布 / 输出解析 / 评分字段), 不依赖宿主。
//
// 从 adapters/dsh/llm-structurer.ts 抽出 (2026-11-01): 回填脚本 (scripts/backfill-sessions.ts) 在 DSH 进程之外
// 走 OpenAI 兼容接口结构化历史会话, 必须用**同一份**提示词排布与解析, 否则回填出来的条目与在线捕获形状不同。
// llm-structurer.ts 原样转出这三个函数, 既有调用方与测试不变。
import type { StructuredTurn, TurnStructurer } from "./structurer.ts";

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

/**
 * 结构化器的输入材料 (问答对 / 负面轮次的全量上下文)。从 makeLlmStructurer 抽出 (2026-11-01):
 * 回填脚本 (scripts/backfill-sessions.ts) 走 OpenAI 兼容接口时要用**同一份**排布, 不另写一套。
 */
export function structurerTurnText(input: Parameters<TurnStructurer["structure"]>[0]): string {
  if (input.transcript) {
    return [
      input.transcript ?? "",
      "",
      "以上是到目前为止的完整对话。最后那条用户消息就是批评;",
      "结合你在它之前做的事, 说清你具体做错了什么。",
    ].join("\n");
  }
  return input.answer ? "用户: " + input.text + "\n\n助手: " + input.answer : input.text;
}

/** 解析模型输出为 StructuredTurn (与 makeLlmStructurer 同一实现; 回填脚本复用)。 */
export function parseStructurerOutput(out: string, input: { text: string }): StructuredTurn {
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
}
