// app/format.ts — 注入块的文本格式化。
//
// 为什么独立: 这是**呈现**逻辑 (人读 + git diff 友好), 与检索/演化无关。
// 放在 facade.ts 里会让"改措辞"看起来像改动核心逻辑, 也让 facade 无谓变长。
import type { RetrievalHit } from "../kernel/ports.ts";

/** 注入块格式化 (与 v1 的注入风格一致, 便于人读与 diff)。空命中返回空串 (= 不注入)。 */
export function formatRetrieval(hits: readonly RetrievalHit[], title: string): string {
  if (!hits.length) return "";
  const lines = ["【" + title + "】"];
  for (const hit of hits) {
    const e = hit.entry;
    const prefix = e.kind === "rule" ? "[规则] " : "";
    lines.push("- " + prefix + "[" + e.id + "] " + e.content);
  }
  return lines.join("\n");
}
