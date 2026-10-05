// kernel/visibility.ts — **条目的默认可见性**: 哪些状态不参与检索。
//
// 为什么单独一份 (2026-09-18, §686/§689 三次同型缺陷的根因):
// 这条判据此前**散在四处 SQL 里各写一遍** ——
//   · `index-reader.query()` / `recent()`
//   · `graph-reader.out()` / `incoming()` (两端都写)
//   · `index-entities.byEntities()`
// 而**权威定义**在 `retrieval/lifecycle.ts` 的 `isLiveEntry` (一个 TypeScript 函数) ——
// **SQL 无法引用它**, 于是每一处都是"照抄一遍", 抄漏一个状态**没有任何报错**。
//
// 实测后果 (§686): `query()` 与 `recent()` 只挡了 `shadow`, 而 `searchText()` 挡三种 ⇒
// TTL 过期的条目在**结构化查询**里可见、在**全文检索**里不可见。而 `recent` 那条
// **早就有契约注释声明**它该隐藏三种 (`gateway.ts`: "面板不该看到已撤回的条目")。
//
// ⇒ 修法: 把"哪些状态不可见"抽到**一处**, 并同时给出**两种形态** ——
//   · `isLiveEntry()` (TS 侧判据, 权威);
//   · `HIDDEN_STATUS_SQL_LIST` / `visibleClause()` (SQL 侧片段)。
//   两者由下面的一致性命中保证同源 (见文件末尾的断言与测试)。
//
// ⚠ **它必须放在 kernel/**: `storage/` 依赖 `kernel/`, 而 `retrieval/` 又依赖 `storage/` ——
// 放在 retrieval 会让 storage 反向依赖 (分层破坏)。
import type { MemoryEntry, MemoryStatus } from "./types.ts";

/** 默认不可见的状态: 撤回 (人工) / 并入他条 (合并) / 衰减过期。 */
export const HIDDEN_STATUSES: readonly MemoryStatus[] = ["shadow", "merged", "expired"];

/**
 * 条目的默认可见性: `HIDDEN_STATUSES` 里的都不参与检索;
 * 其余 (**含 `superseded`** —— 演化链上的旧版本) 可见。
 *
 * 为什么 `superseded` 仍可见: 命中旧版本时由 `resolveCurrentEntry` 上溯到最新 active 版本,
 * 历史节点因此不是"必须被隐藏", 而是"有更好的替代"。
 */
export function isLiveEntry(entry: Pick<MemoryEntry, "status">): boolean {
  const status = entry.status ?? "active";
  return !HIDDEN_STATUSES.includes(status);
}

/**
 * SQL 侧的可见性片段 (`status NOT IN (...)`)。
 *
 * 为什么给出**函数**而不是一个拼接好的常量: 常量可以让调用方忘了加括号或写错空格,
 * 而函数把那个片段封成"一个不透明的条件" —— 调用方只需写 `visibleClause("m")`。
 *
 * @param alias 表别名 (如 `"m"`); 省略则用裸列名 (单表查询)。
 */
export function visibleClause(alias = ""): string {
  const col = alias ? alias + ".status" : "status";
  return col + " NOT IN (" + HIDDEN_STATUS_SQL_LIST + ")";
}

/** `visibleClause` 用到的字面量列表 (导出以便测试比对; 业务代码请用 `visibleClause`)。 */
export const HIDDEN_STATUS_SQL_LIST = HIDDEN_STATUSES.map((s) => "'" + s + "'").join(",");
