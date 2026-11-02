// adapters/dsh/tools-empty-answer.ts — 检索为空时的两级回答 (2026-11-02 从 tools.ts 拆出, verify-structure 400 行约束)。
import type { MemoryEntry } from "../../kernel/types.ts";
import type { MemoryOperations } from "../../kernel/ports.ts";
import type { MemoryToolDeps } from "./tools.ts";

/**
 * 空结果的**可诊断**回答 (2026-10-06 新增)。
 *
 * 为什么不能只回一句 No relevant memory found. (用户实测):
 * 近 7 天 24 次主线程检索里 13 次拿到这句, 而其中 **13/13 在库里都有字面命中的条目** 
 * 它们全被「范围未知 + scopeRequired」挡掉了 (见 docs/memory-failure-audit-20261006.md 第三节)。
 * 一句话的空结果把**两种完全不同的处境**说成同一件事:
 *   · 库里真的没有这条知识  模型该换词或就此打住;
 *   · 库里可能有, 但这次检索没拿到  模型该换个说法, 或干脆别信这个否定。
 * 后果不是「少给几条」, 而是**模型把不知道伪装成知道**: 工具描述里原写死了
 * 「if it returns nothing, that record does not exist」, 于是它会照着这句断定某件事从未发生。
 *
 * ⚠ **只报计数, 不吐正文**  这是与 tests/s2/memory-search-scope.test.ts 那条
 * 「没有工作区上下文时项目内条目一条都不给」的**红线**的折中:
 * 那个回归挡的是「别的项目的私有内容被当本项目经验」, 而诊断需要的只是
 * 「库里到底有没有沾边的东西」这一个布尔量。把正文给出去等于把红线搬开了 
 * 因此这里只回**条数与所属项目名**, 模型据此知道「该换个范围再查」, 但拿不到别人的内容。
 */
export function emptyAnswer(
  query: string,
  limit: number,
  scope: { project?: string; lineage?: readonly string[] } | undefined,
  deps: MemoryToolDeps,
): string {
  // 无范围再查一次: 只为一件事  回答「库里到底有没有沾边的东西」。
  //
  // ⚠ 必须用 `searchText` (BM25) 而不是 `store.query({ text })`: 后者的 SQL 是
  // `content LIKE '%<整串>%'` (index-reader.ts 的 q.text 分支)  **多词查询恒为空**, 于是
  // 这条兜底会永远走回「一句空话」。本用例集第一版就是这么写错的, 由
  // tests/s2/empty-answer-two-tier.test.ts 当场抓出。
  //
  // 为什么用局部断言取 `searchText`: 它是**同步检索**能力 (FileBackend 有, 见 ports.ts 的
  // MemoryStore.searchText), 但 `MemoryOperations` 端口目前只声明了 query。为了不在这里
  // 顺手扩端口契约 (那会波及所有实现方), 用运行时探测 + 可选调用  引擎没有该能力时
  // 退回 query 的结构化过滤 (多词可能查不到, 但不会崩)。
  const withSearch = deps.store as MemoryOperations & {
    searchText?: (text: string, limit?: number) => MemoryEntry[];
  };
  const candidates = withSearch.searchText
    ? withSearch.searchText(query, Math.min(limit, 5))
    : deps.store.query({ text: query, limit: Math.min(limit, 5) });
  if (!candidates.length) return "No relevant memory found.";
  const where = scope?.project ? scope.project : "unknown workspace";
  // 只统计归属, 不吐内容 (见头注的红线折中)。
  const owners = new Map<string, number>();
  for (const e of candidates) {
    const key = e.scope === "project" ? e.project ?? "(project:?)" : e.scope;
    owners.set(key, (owners.get(key) ?? 0) + 1);
  }
  const summary = [...owners.entries()]
    .map(([k, n]) => k + " x" + n)
    .join(", ");
  return (
    "No memory matched within the current workspace (" + where + "). " +
    "But " + candidates.length + " lexically related entr(y/ies) exist outside it [" + summary + "]. " +
    "They are NOT shown here because their scope is unrelated to this workspace; " +
    "if you need them, widen the scope or ask again with the project name."
  );
}
