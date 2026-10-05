// app/format.ts — 注入块的文本格式化。
//
// 为什么独立: 这是**呈现**逻辑 (人读 + git diff 友好), 与检索/演化无关。
// 放在 facade.ts 里会让"改措辞"看起来像改动核心逻辑, 也让 facade 无谓变长。
import type { RetrievalHit } from "../kernel/ports.ts";
// 行格式只有**一处**定义 (见 injection-format.ts 头注)——这里必须复用它。
// ⚠ 2026-09-29: 注入块与检索结果现在是**两种行格式** (见 formatHitLine 的说明):
//   · 被动注入 `formatEntryLine` —— 无 id (省 88 token/块, id 走消息 source);
//   · 主动检索 (本函数) —— **带 id** (memory_flag 按 id 操作, 模型要引用它)。
// 本函数服务的是"检索结果"出口, 因此用带 id 的那个。
import { formatHitLine } from "../kernel/injection-format.ts";

/**
 * 检索结果格式化 (便于人读与 git diff)。空命中返回空串 (= 不注入)。
 *
 * ⚠ **2026-09-18 修 (真实缺陷)**: 此前这里**自己写了一套行格式** ——
 * `- [规则] [<id>] <正文>`, 即**行首裸 id、无行尾标记**。而 `parseInjectedIds` 只认
 * 行尾标记 `<!--hx-memory:id=<id>-->` ⇒ **本函数产出的块解析不出任何 id**。
 *
 * 后果 (全库实测): 这个函数是 **`session-start` 旧线分支**与 **`codex` 适配器**的注入来源,
 * 于是那些"会话开始"注入的块**不被认定为已注入** —— 真实会话日志里 **2556 处旧格式 /
 * 68 个会话** 命中这条路径, 而 `injectMode: first` 的判据 (`prior.ids.size > 0`) 因此落空。
 *
 * 修法: 复用单一来源 (与 `binder.formatBoundEntries` / `recall.formatSections` 一致)。
 * 「单一事实源」不只是一句原则 —— 这里就是它失效时的样子: 两套格式并存, 而**只有一套能被解析**。
 *
 * ⚠ **2026-09-29 后续**: id 已从**注入块**移出 (走消息 source), 但本函数是**检索结果**出口,
 * 因此改用 `formatHitLine` 保留 id。两条出口的判据见 `formatHitLine` 的说明。
 */
export function formatRetrieval(hits: readonly RetrievalHit[], title: string): string {
  if (!hits.length) return "";
  const lines = ["【" + title + "】"];
  for (const hit of hits) {
    const e = hit.entry;
    // 行首 kind 标记由 `formatHitLine` 统一负责 (给**每种** kind 都加, 不只是 rule);
    // 继续手拼会变成 "- [规则] [rule] ..." 的双重标记, 且非 rule 条目仍无标记。
    lines.push(formatHitLine(e.id, e.content, e.kind));
  }
  return lines.join("\n");
}
