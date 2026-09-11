// app/normalize.ts — 主动整理 / 无损迁移 (真相文件的规范化写回)。
//
// 要解决的问题 (实测): 库里的记忆"新旧形态混在一起" —— 字段数从 9 到 17 不等,
// 因为强化/更新只重写**被命中的那一个块**, 没被命中的老块永远停在旧形态;
// 而版本标记 (format: N) 此前只是写入端常量, 读取端从不比较, 因此升级既不会迁移也不会报错。
//
// 与 consolidate 的分工: consolidate 管**语义**寿命 (衰减/过期/TTL), 这里管**形态**一致性
// (字段补全 + 版本标记), 两者都会写真相文件, 但判据完全不同, 所以是两个服务。
//
// 三条硬约束 (缺一条就不是"无损"):
//   1. **dryRun**: 先看清楚会改什么, 再决定改 —— 与 ConsolidationService 同一契约;
//   2. **幂等**: 跑第二遍必须是零改动 (否则它就是一个每次运行都改文件的噪声源);
//   3. **不碰未知字段**: 写回路径 (upsertBlockInFile) 会搬运陌生 frontmatter 键 (见 storage/frontmatter.ts),
//      否则"整理"会静默吃掉更新版本写入的字段 —— 那是数据丢失, 不是整理。
//
// 为什么不做成"打开时自动跑": 读操作不得改写用户文件 (真相是人的资产, 不是缓存)。
import type { MemoryEntry, MemoryEntryInput, Query } from "../kernel/types.ts";
import { FORMAT_VERSION, normalizeEntry } from "../storage/entry-normalize.ts";
import { blockFormat, frontmatterHeadOf } from "../storage/frontmatter.ts";
import { readFileParts } from "../storage/markdown-codec.ts";
import { walkMd } from "../storage/markdown-parse.ts";

/** 规范化需要的存储面 (窄端口: 适配层只依赖这四项)。 */
export interface NormalizerStore {
  /** 全量读取 (必须含 shadow —— 被撤回的条目也是真相的一部分, 也要能整理)。 */
  query(q: Query): MemoryEntry[];
  get(id: string): MemoryEntry | null;
  /**
   * 写回 (只补形态, 不改语义)。
   * 用既有的 update 即可: 它走的校验对"整理"同样成立 —— 未确认的 rule 在**写入端**就被
   * 治理闸门挡在索引之外 (file-store 的 indexEntry), 因此不存在"需要绕过闸门才能整理"的条目
   * (这一点已实测, 不是推断)。整理了它的就是它的写入路径, 不是特权路径。
   */
  update(id: string, patch: Partial<MemoryEntry>): void;
}

export interface NormalizeOptions {
  /** 只报告不写盘 (默认 false)。 */
  dryRun?: boolean;
  /** 真相目录 (绝对路径); 缺省表示全库。 */
  dirs?: readonly string[];
}

/** 一条条目要做的改变 (可审计: 面板/CLI 直接展示这份清单)。 */
export interface NormalizeChange {
  id: string;
  file: string;
  /** upgraded = 字段形态变化; stamped = 只补磁盘格式版本标记。 */
  action: "upgraded" | "stamped";
  /** 磁盘上原有的 format 值 (缺失 = null, 即 legacy)。 */
  from: number | null;
  to: number;
  /** 具体哪些字段被补全/规范化。 */
  fields: string[];
}

export interface NormalizeReport {
  scanned: number;
  changed: number;
  unchanged: number;
  /** 索引里有、真相文件里找不到的条目 (只报告, 不猜)。 */
  missing: number;
  /** 真跑了才为 true (dryRun 时为 false)。 */
  applied: boolean;
  dryRun: boolean;
  toFormat: number;
  changes: NormalizeChange[];
}

/** 参与"形态"比较的字段 (顺序固定, 便于稳定输出与测试)。 */
const SHAPE_KEYS = [
  "kind",
  "content",
  "source",
  "scope",
  "status",
  "project",
  "tags",
  "entities",
  "importance",
  "confidence",
  "reinforcement",
  "lastHitAt",
  "expiresAt",
  "derivedFrom",
  "mergedFrom",
  "confirmedBy",
  "confirmedAt",
  "structured",
] as const;

/**
 * 取"可比形状"。数组/对象必须先序列化再比 ——
 * 直接 === 比较数组永远不等 (引用不同), 会让**任何带 tags/relations 的条目**都被误报成"需改动"。
 * 这个 bug 在真实库上一跑就暴露: 3 条带 tags/derivedFrom 的条目全被误判。
 */
function shapeOf(e: MemoryEntry): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const raw = e as unknown as Record<string, unknown>;
  for (const k of SHAPE_KEYS) {
    const v = raw[k] ?? null;
    out[k] = typeof v === "object" && v !== null ? JSON.stringify(v) : v;
  }
  out.relations = JSON.stringify(e.relations ?? null);
  out.ts = JSON.stringify(e.ts);
  return out;
}

/** 与规范化结果真正不同的字段 (只把这些写回去, 不整条覆盖)。 */
export function changedFields(before: MemoryEntry, after: MemoryEntry): string[] {
  const a = shapeOf(before);
  const b = shapeOf(after);
  const out = SHAPE_KEYS.filter((k) => a[k] !== b[k]) as string[];
  if (a.relations !== b.relations) out.push("relations");
  if (a.ts !== b.ts) out.push("ts");
  return out;
}

export class MemoryNormalizer {
  private readonly store: NormalizerStore;
  private readonly root: string;

  // 显式字段 + 赋值 (不用 TS 参数属性): Node strip-only 模式不支持。
  constructor(store: NormalizerStore, root: string) {
    this.store = store;
    this.root = root;
  }

  /** 磁盘上每个条目声明的 format 值 (缺失 = 无标记 = legacy)。 */
  private diskFormats(dirs?: readonly string[]): Map<string, { file: string; format?: number }> {
    const out = new Map<string, { file: string; format?: number }>();
    const files = dirs?.length ? dirs.flatMap((d) => walkMd(d)) : walkMd(this.root);
    for (const file of files) {
      for (const block of readFileParts(file).blocks) {
        const head = frontmatterHeadOf(block);
        if (head === null) continue;
        const id = head.match(/^id: (.*)$/m)?.[1];
        if (!id) continue;
        const format = blockFormat(block);
        out.set(id, { file, ...(format === undefined ? {} : { format }) });
      }
    }
    return out;
  }

  /**
   * 跑一次整理。**幂等**: 第二遍必然 changed=0 (由"先规范化再比形状"保证)。
   * dryRun 时只出报告 —— 这是默认用法: 先看清单, 再决定是否落盘。
   */
  run(opts: NormalizeOptions = {}): NormalizeReport {
    const dryRun = opts.dryRun ?? false;
    // 含 shadow: 撤回的条目也要保持形态一致 (否则迁移后会留下两代格式)。
    const entries = this.store.query({ includeShadow: true, limit: Number.MAX_SAFE_INTEGER });
    const disk = this.diskFormats(opts.dirs);

    const report: NormalizeReport = {
      scanned: entries.length,
      changed: 0,
      unchanged: 0,
      missing: 0,
      applied: false,
      dryRun,
      toFormat: FORMAT_VERSION,
      changes: [],
    };

    for (const entry of entries) {
      const onDisk = disk.get(entry.id);
      if (!onDisk) {
        report.missing += 1;
        continue;
      }
      const next = normalizeEntry(entry as MemoryEntryInput & { id: string });
      const fields = changedFields(entry, next);
      const staleFormat = onDisk.format !== FORMAT_VERSION;
      if (!fields.length && !staleFormat) {
        report.unchanged += 1;
        continue;
      }
      report.changed += 1;
      report.changes.push({
        id: entry.id,
        file: onDisk.file,
        action: fields.length ? "upgraded" : "stamped",
        from: onDisk.format ?? null,
        to: FORMAT_VERSION,
        fields,
      });
      if (dryRun) continue;
      // 只写真正变化的字段 + ts: 写回本身会把磁盘块补上当前 format 标记 (见 entryToMarkdown)。
      const patch: Partial<MemoryEntry> = { ts: next.ts };
      for (const f of fields)
        (patch as unknown as Record<string, unknown>)[f] = (
          next as unknown as Record<string, unknown>
        )[f];
      this.store.update(entry.id, patch);
      report.applied = true;
    }
    return report;
  }
}
