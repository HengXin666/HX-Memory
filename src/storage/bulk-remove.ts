// storage/bulk-remove.ts — 批量撤回/物理删除 (FileBackend.removeMany 的实现)。
//
// 为什么单独成文件: file-store.ts 贴着 400 行上限, 且批量删除只在治理脚本里用 (清知识库 / 清凭据),
// 与日常写入路径无关。判据与单条 remove() 完全一致:
//   · hard=true (allowTruthDelete): 真相文件里摘块 + 索引行 (memories/tags/entities/relations.from/FTS) 删除;
//   · hard=false: 逐条走 remove() 写 shadow (与默认治理口径一致, 不另起一套)。
// 区别只在 IO: 按真相文件分组, 每个文件只读写一次; 索引删除包在一个事务里 (要么全清, 要么不动)。
//
// 2026-11-01 实测动机: 知识库 4672 条 doc, 其中 4058 条在同一个 7.7MB 的 daily/2026-06-13.md,
// 逐条 remove 要把它整读整写 4058 遍。
import type { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { MemoryEntry } from "../kernel/types.ts";
import { fileFor } from "./entry-normalize.ts";
import { removeBlocksFromFile } from "./markdown-codec.ts";

export interface BulkRemoveReport {
  requested: number;
  /** 索引里找到的条数 (找不到的 id 视为已删除, 幂等)。 */
  found: number;
  /** 真相文件里实际摘掉的块数 (hard 模式); soft 模式为 0。 */
  blocksRemoved: number;
  /** 涉及的真相文件 (相对 root)。 */
  files: Record<string, number>;
  /** hard 模式下, 被摘掉「指向被删条目的入边」的其他条目数 (见 detachIncoming)。 */
  detachedFrom: number;
  mode: "hard" | "shadow";
}

export interface BulkRemoveDeps {
  root: string;
  db: DatabaseSync;
  ids: readonly string[];
  hard: boolean;
  get: (id: string) => MemoryEntry | null;
  drop: (id: string) => void;
  soft: (id: string) => void;
  /** 改写某条记忆的 relations (真相文件 + 索引一起; FileBackend 里就是 update)。缺省 = 不处理入边 (旧行为)。 */
  rewriteRelations?: (id: string, relations: NonNullable<MemoryEntry["relations"]>) => void;
}

/**
 * 摘掉**指向被删条目的入边** (2026-11-01 补)。
 *
 * 为什么不是在索引里 `DELETE FROM relations WHERE to_id = ?` 就完事: 关系是写在**源条目自己的真相块**里的
 * (A 的块声明 `relates → B`)。只删索引行, 下次 rebuildFromFiles 会从 A 的块里把这条边原样建回来,
 * 而 B 已经不存在 ⇒ 一条永久的悬空边。所以必须改写 A 本身 (真相 + 索引一起), 也就是走 update。
 * 被删集合内部互相指的边不用管 (源条目自己也在被删)。
 */
export function detachIncoming(
  db: DatabaseSync,
  removed: ReadonlySet<string>,
  get: (id: string) => MemoryEntry | null,
  rewrite: (id: string, relations: NonNullable<MemoryEntry["relations"]>) => void,
): number {
  if (!removed.size) return 0;
  const holders = new Set<string>();
  const ids = [...removed];
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const rows = db.prepare(`SELECT DISTINCT from_id FROM relations WHERE to_id IN (${chunk.map(() => "?").join(",")})`).all(...chunk) as Array<{ from_id: string }>;
    for (const r of rows) if (!removed.has(r.from_id)) holders.add(r.from_id);
  }
  let n = 0;
  for (const h of holders) {
    const e = get(h);
    if (!e) continue;
    const kept = (e.relations ?? []).filter((r) => !removed.has(r.toId));
    if (kept.length === (e.relations ?? []).length) continue;
    rewrite(h, kept);
    n++;
  }
  return n;
}

/**
 * 批量撤回/物理删除, 每个真相文件只读写一次
 * .agents/notes/implemented/feature/2026-11-01-bulk-hard-remove.md
 */
export function bulkRemove(deps: BulkRemoveDeps): BulkRemoveReport {
  const report: BulkRemoveReport = {
    requested: deps.ids.length,
    found: 0,
    blocksRemoved: 0,
    files: {},
    mode: deps.hard ? "hard" : "shadow",
    detachedFrom: 0,
  };
  const byFile = new Map<string, Set<string>>();
  for (const id of new Set(deps.ids)) {
    const e = deps.get(id);
    if (!e) continue;
    report.found++;
    const rel = fileFor(e);
    const set = byFile.get(rel) ?? new Set<string>();
    set.add(id);
    byFile.set(rel, set);
  }
  if (!deps.hard) {
    for (const ids of byFile.values()) for (const id of ids) deps.soft(id);
    for (const [rel, ids] of byFile) report.files[rel] = ids.size;
    return report;
  }
  // 入边先摘 (改写的是**其他**条目, 它们留在库里): 放在删块之前, 这样中途失败时只会多出「已摘边、未删除」
  // 的状态 (重跑即可), 不会出现「已删除、仍被指着」的悬空边。
  if (deps.rewriteRelations) {
    const removed = new Set<string>();
    for (const ids of byFile.values()) for (const id of ids) removed.add(id);
    report.detachedFrom = detachIncoming(deps.db, removed, deps.get, deps.rewriteRelations);
  }
  // 先改真相, 再清索引: 中途失败时索引里多出的行会在下次打开的计数自检里被发现并重建,
  // 反过来 (先清索引) 则重建会让真相里残留的块复活  所以真相优先。
  for (const [rel, ids] of byFile) {
    const file = join(deps.root, rel);
    const n = existsSync(file) ? removeBlocksFromFile(file, ids) : 0;
    report.files[rel] = n;
    report.blocksRemoved += n;
  }
  deps.db.exec("BEGIN");
  try {
    for (const ids of byFile.values()) for (const id of ids) deps.drop(id);
    deps.db.exec("COMMIT");
  } catch (error) {
    // 某些错误 (磁盘满 / IO) 会让 sqlite 自己回滚, 此时再 ROLLBACK 会抛错并盖住真正的原因。
    if (deps.db.isTransaction) deps.db.exec("ROLLBACK");
    throw error;
  }
  return report;
}
