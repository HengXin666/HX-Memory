// src/adapters/codex/agents-md.ts — 生成/更新 AGENTS.md (Codex 的持久记忆)。
// Codex 会把仓库根 AGENTS.md 作为长期上下文。HX-Memory 把"已确认的跨项目规则"
// 写进去, 让任何项目的新 Codex 会话自动带上这些不变量。
// 幂等: 每次全量重写规则区段 (带标记, 手动内容保留)。
import type { MemoryEntry } from "../../kernel/types.ts";

const START = "<!-- hx-memory:rules:start -->";
const END = "<!-- hx-memory:rules:end -->";

export interface AgentsMdOptions {
  /** 已有 AGENTS.md 内容 (读取后传入)。 */
  existing: string;
  /** 要写入的确认规则 (scope:global, kind:rule)。 */
  rules: MemoryEntry[];
  language?: "zh" | "en";
}

const ZH_HEAD =
  "# HX-Memory 跨项目规则 (已确认)\n\n以下规则来自长期记忆, 已在其他项目验证, 适用于本项目:";
const EN_HEAD =
  "# HX-Memory Cross-Project Rules (confirmed)\n\nThese rules come from long-term memory and apply to this project:";

export function renderRulesMd(opts: AgentsMdOptions): string {
  const head = opts.language === "en" ? EN_HEAD : ZH_HEAD;
  const items = opts.rules.length
    ? opts.rules
        .map((r) => "- " + r.content + "  \n  _来源: " + (r.source || "hx-memory") + "_")
        .join("\n")
    : "_暂无已确认规则。_";
  return START + "\n" + head + "\n" + items + "\n" + END;
}

/** 把规则区段写进 AGENTS.md, 保留区段外的既有内容。 */
export function updateAgentsMd(opts: AgentsMdOptions): string {
  const section = renderRulesMd(opts);
  const { existing } = opts;
  const startIdx = existing.indexOf(START);
  const endIdx = existing.indexOf(END);
  if (startIdx === -1 || endIdx === -1) {
    // 尚无区段 → 追加到末尾
    const trimmed = existing.trimEnd();
    return trimmed ? trimmed + "\n\n" + section + "\n" : section + "\n";
  }
  // 替换既有区段
  return existing.slice(0, startIdx) + section + existing.slice(endIdx + END.length);
}

/** 空规则占位符 (用于区分"本来就没规则"与"索引查不到规则")。 */
export const EMPTY_MARKER = "_暂无已确认规则。_";

export { START, END };
