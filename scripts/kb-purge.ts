// scripts/kb-purge.ts — 清掉记忆根里的知识库切片 (source 以 "kb:" 开头的 doc), 只保留对话沉淀。
//
// ## 为什么不是一条 SQL (2026-11-01 实测)
//
// index.sqlite 是**派生索引**, 真相在 Markdown (src/storage/README.md 不变量 1)。
// 知识库的 4672 条 doc 落在 12 个 daily 真相文件里 (daily/2026-06-13.md 一个就有 4058 条, 7.7MB)。
// 只删 sqlite 的话, 任何一次 rebuildFromFiles() (索引丢失 / 分词版本升级 / 手动重建) 都会让它们**全部复活**。
// 所以走仓库自己的删除入口: FileBackend({ allowTruthDelete: true }).removeMany()
//   = 与单条 remove() 同一判据 (真相文件摘块 + memories/tags/entities/relations.from/FTS 删行),
//     只是按文件分组、每个文件读写一次, 索引删除在一个事务里。
//
// ## 顺序 (每一步失败都会停, 不会进入下一步)
//   1. 备份: index.sqlite 一致性快照 (sqlite backup API) + 原样复制 -wal/-shm + 整棵真相目录;
//      备份后**重新打开备份数行数**, 与实时库逐 kind 对齐, 不一致就停;
//   2. 选取: source LIKE 'kb:%' AND kind = 'doc' (两个条件同时成立才删, 防误伤);
//   3. 删除: removeMany (仅 --apply 时);
//   4. 校验 (六条): kb 残留 0 / 对话沉淀逐 kind 不变 / FTS 与 memories 行数一致且无孤儿 /
//      tags/entities/relations 无孤儿 / 真相文件里无 "source: kb:" / **从真相重建一份索引, doc 仍为 0** (证明不复活);
//   5. 面板配置: panel.json 的 kb 来源列表清空 (先备份), 否则下次点「同步」会再灌回来;
//   6. 报告: <备份目录>/kb-purge-report.json + .md。
//
// ## 用法
//   node --experimental-strip-types scripts/kb-purge.ts                 # dry-run: 只做备份与清单, 不删
//   node --experimental-strip-types scripts/kb-purge.ts --apply         # 真删
//   选项: --root <记忆根> (默认 $HX_MEMORY_ROOT 或 ~/.dsh/hx-memory)
//         --backup <目录>  (默认 ~/.dsh/hx-memory-backup-kbpurge-<YYYYMMDD>)
//         --keep-panel-config  不动 panel.json
import { DatabaseSync } from "node:sqlite";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { FileBackend } from "../src/storage/file-store.ts";

const argv = process.argv.slice(2);
const opt = (n: string): string | undefined => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : undefined;
};
const APPLY = argv.includes("--apply");
const ROOT = opt("--root") ?? process.env.HX_MEMORY_ROOT ?? join(homedir(), ".dsh", "hx-memory");
const DAY = new Date().toISOString().slice(0, 10).replace(/-/g, "");
const BACKUP = opt("--backup") ?? join(homedir(), ".dsh", "hx-memory-backup-kbpurge-" + DAY);
const PANEL_CFG = join(process.env.HX_PANEL_CONFIG_DIR ?? join(homedir(), ".config", "hx-memory-panel"), "panel.json");
const KB_WHERE = "source LIKE 'kb:%' AND kind = 'doc'";

type Counts = { total: number; active: number; kb: number; fts: number; byKind: Record<string, number> };
/**
 * 各口径行数
 * .agents/notes/implemented/feature/2026-11-01-bulk-hard-remove.md
 */
function counts(file: string): Counts {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const one = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
    const byKind: Record<string, number> = {};
    for (const r of db.prepare("SELECT kind, COUNT(*) AS n FROM memories WHERE NOT (" + KB_WHERE + ") GROUP BY kind ORDER BY kind").all() as Array<{ kind: string; n: number }>) byKind[r.kind] = r.n;
    return {
      total: one("SELECT COUNT(*) AS n FROM memories"),
      active: one("SELECT COUNT(*) AS n FROM memories WHERE status = 'active'"),
      kb: one("SELECT COUNT(*) AS n FROM memories WHERE " + KB_WHERE),
      fts: one("SELECT COUNT(*) AS n FROM memories_fts"),
      byKind,
    };
  } finally {
    db.close();
  }
}
const same = (a: object, b: object) => JSON.stringify(a) === JSON.stringify(b);
const log = (...a: unknown[]) => console.log(...a);
const fail = (msg: string): never => {
  console.error("✗ " + msg + "\n  (已停止; 记忆根未被修改)" );
  process.exit(1);
};

const INDEX = join(ROOT, "index.sqlite");
if (!existsSync(INDEX)) fail("找不到 " + INDEX);
const report: Record<string, unknown> = { root: ROOT, backup: BACKUP, apply: APPLY, startedAt: new Date().toISOString() };

// ---------- 1. 备份 ----------
const before = counts(INDEX);
report.before = before;
log("① 备份前:", JSON.stringify(before));
mkdirSync(BACKUP, { recursive: true });
const SNAP = join(BACKUP, "index.snapshot.sqlite");
if (!existsSync(SNAP)) {
  // sqlite backup API: 含 WAL 中未 checkpoint 的数据, 是一致性快照 (原样 cp 三件套可能撕裂)。
  const src = new DatabaseSync(INDEX, { readOnly: true });
  src.exec("VACUUM INTO '" + SNAP.replace(/'/g, "''") + "'");
  src.close();
}
for (const f of ["index.sqlite", "index.sqlite-wal", "index.sqlite-shm"]) {
  const s = join(ROOT, f);
  if (existsSync(s) && !existsSync(join(BACKUP, f))) cpSync(s, join(BACKUP, f));
}
const TRUTH_BAK = join(BACKUP, "truth");
if (!existsSync(TRUTH_BAK)) {
  for (const name of readdirSync(ROOT)) {
    if (name.startsWith("index.sqlite")) continue;
    cpSync(join(ROOT, name), join(TRUTH_BAK, name), { recursive: true });
  }
}
const snap = counts(SNAP);
report.backupCounts = snap;
log("  备份快照:", JSON.stringify(snap));
// 备份时 DSH 可能正好写入新的对话条目 (只增不减), 所以要求: kb 相等, 对话沉淀每个 kind 备份 >= 备份前。
if (snap.kb !== before.kb) fail("备份快照的 kb 行数 " + snap.kb + " ≠ 实时库 " + before.kb);
for (const [k, n] of Object.entries(before.byKind)) if ((snap.byKind[k] ?? 0) < n) fail("备份快照里 " + k + " 少了: " + snap.byKind[k] + " < " + n);
log("  ✓ 备份完成并核对: " + BACKUP);

// ---------- 2. 选取 ----------
const sel = new DatabaseSync(INDEX, { readOnly: true });
const ids = (sel.prepare("SELECT id FROM memories WHERE " + KB_WHERE).all() as Array<{ id: string }>).map((r) => r.id);
const files = sel.prepare("SELECT file, COUNT(*) AS n FROM memories WHERE " + KB_WHERE + " GROUP BY file ORDER BY n DESC").all();
const nonDocKb = (sel.prepare("SELECT COUNT(*) AS n FROM memories WHERE source LIKE 'kb:%' AND kind <> 'doc'").get() as { n: number }).n;
sel.close();
report.selected = { ids: ids.length, files, nonDocKbIgnored: nonDocKb };
log("② 选中 " + ids.length + " 条 (source kb: 且 kind doc), 分布在 " + files.length + " 个真相文件; source kb: 但不是 doc 的 " + nonDocKb + " 条不动");

if (!APPLY) {
  log("\n(dry-run) 备份已做, 没有删除任何东西。确认无误后加 --apply 执行。");
  writeFileSync(join(BACKUP, "kb-purge-dryrun.json"), JSON.stringify(report, null, 2));
  process.exit(0);
}

// ---------- 3. 删除 (仓库入口) ----------
const t0 = Date.now();
const store = new FileBackend({ root: ROOT, allowTruthDelete: true });
const removed = store.removeMany(ids);
const verifyReport = store.verify();
store.close();
report.removed = { ...removed, ms: Date.now() - t0 };
log("③ removeMany:", JSON.stringify({ found: removed.found, blocksRemoved: removed.blocksRemoved, mode: removed.mode, ms: Date.now() - t0 }));

// ---------- 4. 校验 ----------
const after = counts(INDEX);
report.after = after;
const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
checks.push({ name: "kb 残留为 0", ok: after.kb === 0, detail: "kb=" + after.kb });
const dialogOk = Object.entries(before.byKind).every(([k, n]) => (after.byKind[k] ?? 0) >= n) && Object.keys(after.byKind).every((k) => k in before.byKind || k !== "doc");
checks.push({ name: "对话沉淀逐 kind 不少", ok: dialogOk, detail: JSON.stringify(before.byKind) + " → " + JSON.stringify(after.byKind) });
const db = new DatabaseSync(INDEX, { readOnly: true });
const one = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
const orph = {
  fts: one("SELECT COUNT(*) AS n FROM memories_fts WHERE memory_id NOT IN (SELECT id FROM memories)"),
  tags: one("SELECT COUNT(*) AS n FROM tags WHERE memory_id NOT IN (SELECT id FROM memories)"),
  entities: one("SELECT COUNT(*) AS n FROM entities WHERE memory_id NOT IN (SELECT id FROM memories)"),
  relationsFrom: one("SELECT COUNT(*) AS n FROM relations WHERE from_id NOT IN (SELECT id FROM memories)"),
  relationsTo: one("SELECT COUNT(*) AS n FROM relations WHERE to_id NOT IN (SELECT id FROM memories)"),
};
db.close();
checks.push({ name: "FTS 行数 = memories 行数", ok: after.fts === after.total && orph.fts === 0, detail: "fts=" + after.fts + " memories=" + after.total + " 孤儿=" + orph.fts });
// relations.to 的孤儿在删除前就可能存在 (指向早已物理删除的条目), 只要求本次没有新增。
checks.push({ name: "tags/entities/relations.from 无孤儿", ok: orph.tags === 0 && orph.entities === 0 && orph.relationsFrom === 0, detail: JSON.stringify(orph) });
const kbInTruth: string[] = [];
const scan = (dir: string) => {
  if (!existsSync(dir)) return;
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) scan(p);
    else if (n.endsWith(".md") && /^source: kb:/m.test(readFileSync(p, "utf8"))) kbInTruth.push(p);
  }
};
for (const d of ["daily", "digest", "rules"]) scan(join(ROOT, d));
checks.push({ name: "真相文件里无 source: kb:", ok: kbInTruth.length === 0, detail: kbInTruth.slice(0, 5).join(", ") || "0 个文件" });
// 重建演练: 把真相 (不含索引) 拷到临时目录, 让 FileBackend 从文件重建, doc 必须仍为 0。
const tmp = mkdtempSync(join(tmpdir(), "kbpurge-rebuild-"));
for (const d of ["daily", "digest", "rules"]) if (existsSync(join(ROOT, d))) cpSync(join(ROOT, d), join(tmp, d), { recursive: true });
const rebuilt = new FileBackend({ root: tmp });
rebuilt.close();
const rb = counts(join(tmp, "index.sqlite"));
rmSync(tmp, { recursive: true, force: true });
checks.push({ name: "从真相重建后 doc 仍为 0 (不复活)", ok: rb.kb === 0 && (rb.byKind.doc ?? 0) === 0, detail: "重建 total=" + rb.total + " kb=" + rb.kb });
report.orphans = orph;
report.verify = verifyReport;
report.checks = checks;
log("④ 校验:");
for (const c of checks) log("  " + (c.ok ? "✓" : "✗") + " " + c.name + "  " + c.detail);

// ---------- 5. 面板配置 ----------
if (!argv.includes("--keep-panel-config") && existsSync(PANEL_CFG)) {
  const raw = readFileSync(PANEL_CFG, "utf8");
  writeFileSync(join(BACKUP, "panel.json.bak"), raw);
  const cfg = JSON.parse(raw) as { kb?: unknown[] };
  report.panelKbCleared = cfg.kb ?? [];
  cfg.kb = [];
  writeFileSync(PANEL_CFG, JSON.stringify(cfg, null, 2) + "\n");
  log("⑤ panel.json 的知识库来源已清空 (原文件备份在 panel.json.bak)");
}

// ---------- 6. 报告 ----------
report.finishedAt = new Date().toISOString();
const allOk = checks.every((c) => c.ok);
report.ok = allOk;
writeFileSync(join(BACKUP, "kb-purge-report.json"), JSON.stringify(report, null, 2));
const md = [
  "# kb 清理报告",
  "",
  "- 记忆根: `" + ROOT + "`  备份: `" + BACKUP + "`",
  "- 备份前: total " + before.total + " / active " + before.active + " / kb " + before.kb + " / fts " + before.fts,
  "- 备份快照: total " + snap.total + " / kb " + snap.kb,
  "- 删除后: total " + after.total + " / active " + after.active + " / kb " + after.kb + " / fts " + after.fts,
  "- 对话沉淀 (按 kind): " + JSON.stringify(after.byKind),
  "- 真相文件摘块: " + removed.blocksRemoved + " (" + Object.keys(removed.files).length + " 个文件)",
  "",
  "| 校验 | 结果 | 明细 |",
  "|---|---|---|",
  ...checks.map((c) => "| " + c.name + " | " + (c.ok ? "✓" : "✗") + " | " + c.detail.replace(/\|/g, "/") + " |"),
  "",
  "回滚: 停 DSH 与面板 → 用 " + BACKUP + "/truth/* 覆盖记忆根同名目录 → 删掉 index.sqlite* → 重新打开即从真相重建 (或直接拷回 index.sqlite 三件套)。",
].join("\n");
writeFileSync(join(BACKUP, "kb-purge-report.md"), md + "\n");
log("⑥ 报告: " + join(BACKUP, "kb-purge-report.md"));
log(allOk ? "\n✓ 全部校验通过" : "\n✗ 有校验未通过, 见报告; 备份在 " + BACKUP);
process.exit(allOk ? 0 : 1);
