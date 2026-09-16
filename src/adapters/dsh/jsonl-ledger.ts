// adapters/dsh/jsonl-ledger.ts — 追加式 JSONL 账本的**唯一实现**。
//
// 为什么要有它: 本目录已经有两个"按天分文件、只追加、永不改写、best-effort、带保留期与行数上限"
// 的账本 (schedule-log 与 capture-log)。把这段语义写第二遍就会引出两个问题:
//   1. 结构 gate (verify-structure) 的 jscpd 会把它判成重复块;
//   2. 更要紧的是它会**分叉** —— 保留期/上限/失败语义只改了一处, 另一处静默保持旧行为,
//      而这类账本的失效恰恰是静默的 (写不进去只是少几行, 没人会注意到)。
// 因此共同部分收敛在这里, 两个账本各自只保留"记录形状 + 聚合视图"。
//
// 三条不变量 (与 schedule-log 原始设计一致, 这里只是把它变成共享的):
//   1. 账本是**真相文件**: 只追加、永不改写, 坏了只丢一行 —— 因此没有重建路径, 只有保留期;
//   2. 写入永远 **best-effort**: append 不抛错, 失败只置一个可观测标志 (记忆层不许拖垮对话);
//   3. 单日行数上限: 账本不许长成拖垮宿主的东西 (到顶就拒写, 不轮转、不重写)。
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

/** 日期目录名/文件名只认这个形态 (非此形态的文件不参与保留期清理)。 */
export const LEDGER_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export interface JsonlLedgerConfig {
  /** 账本目录 (记录落在 <dir>/YYYY-MM-DD.jsonl)。 */
  dir: string;
  /** 保留天数 (0 = 永久); 允许传函数以便设置面板改动当轮生效。 */
  retentionDays?: number | (() => number);
  /** 单日行数上限; 同样允许传函数。 */
  maxLinesPerDay?: number | (() => number);
}

/**
 * 一个按天分文件的追加式 JSONL 账本。
 *
 * 子类 (ScheduleLog / CaptureLog) 负责记录形状与聚合视图; 本类只管**落盘语义**。
 * 子类的 append 应当只是"把强类型记录交给 appendLine", 不要再自己拼一条写路径 ——
 * 那正是这条共享实现要消灭的东西。
 */
export class JsonlLedger {
  private readonly dir: string;
  private readonly retentionDays: number | (() => number);
  private readonly maxLinesPerDay: number | (() => number);
  /** 写失败只记一次 (每步都报会刷屏, 而刷屏的日志等于没有日志)。 */
  private writeFailed = false;
  /** 每写 200 条做一次懒 prune —— 不需要后台定时器。 */
  private writes = 0;

  constructor(config: JsonlLedgerConfig) {
    this.dir = config.dir;
    this.retentionDays = config.retentionDays ?? 0;
    this.maxLinesPerDay = config.maxLinesPerDay ?? Number.MAX_SAFE_INTEGER;
  }

  /** 账本目录 (人可读位置; 备份/排查时按它取)。 */
  get dirPath(): string {
    return this.dir;
  }

  /** 最近一次写入是否失败过 (可观测: 静默失败也要能被问出来)。 */
  hasWriteFailed(): boolean {
    return this.writeFailed;
  }

  /**
   * 追加一条记录。返回是否真的落盘。
   * 永不抛错: 账本写不进去不该让这一轮对话失败 (best-effort)。
   */
  appendLine(record: unknown, at: string): boolean {
    try {
      mkdirSync(this.dir, { recursive: true });
      const file = this.fileFor(at);
      if (this.countLines(file) >= this.num(this.maxLinesPerDay)) return false;
      appendFileSync(file, JSON.stringify(record) + "\n", "utf8");
      this.writes += 1;
      // 懒 prune: 每 200 条一次, 以"整天文件"为单位删 (与布局一致, 不重写文件)。
      if (this.writes % 200 === 0) this.prune(at);
      return true;
    } catch {
      this.writeFailed = true;
      return false;
    }
  }

  /** 原始行 (新→旧)。坏行也原样返回 —— 解析由子类负责 (坏行跳过, 不让整份不可读)。 */
  lines(limit = 100): string[] {
    const max = Math.max(1, Math.min(10_000, limit));
    const out: string[] = [];
    for (const file of this.files().reverse()) {
      const lines = this.readLine(file);
      for (let i = lines.length - 1; i >= 0 && out.length < max; i--) {
        const line = lines[i] ?? "";
        if (line.trim()) out.push(line);
      }
      if (out.length >= max) break;
    }
    return out;
  }

  /** 账本文件数 / 记录条数 (面板顶部的体量信息)。 */
  size(): { files: number; records: number } {
    let records = 0;
    for (const file of this.files()) records += this.countLines(file);
    return { files: this.files().length, records };
  }

  /** 按保留期清理整天文件。retentionDays<=0 时是 no-op。 */
  prune(now = new Date().toISOString()): number {
    const days = this.num(this.retentionDays);
    if (days <= 0) return 0;
    const cutoff = new Date(Date.parse(now) - days * 86_400_000).toISOString().slice(0, 10);
    let removed = 0;
    for (const file of this.files()) {
      const day = file.slice(file.lastIndexOf("/") + 1).replace(/\.jsonl$/, "");
      if (!LEDGER_DAY_PATTERN.test(day) || day >= cutoff) continue;
      removed += this.countLines(file);
      rmSync(file, { force: true });
    }
    return removed;
  }

  private num(value: number | (() => number)): number {
    const raw = typeof value === "function" ? value() : value;
    return Number.isFinite(raw) ? Math.floor(raw) : 0;
  }

  private fileFor(at: string): string {
    return join(this.dir, at.slice(0, 10) + ".jsonl");
  }

  private files(): string[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((name) => name.endsWith(".jsonl"))
      .sort()
      .map((name) => join(this.dir, name));
  }

  private readLine(file: string): string[] {
    try {
      return readFileSync(file, "utf8").replace(/^\uFEFF/, "").split("\n");
    } catch {
      return [];
    }
  }

  private countLines(file: string): number {
    let n = 0;
    for (const line of this.readLine(file)) if (line.trim()) n += 1;
    return n;
  }
}
