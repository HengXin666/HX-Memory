// scripts/capture-check.ts — 采集是否正常的只读体检 (不改任何文件)。重新启用插件后用它判断。
//
// 用法: node --experimental-strip-types --no-warnings scripts/capture-check.ts [--root ~/.dsh/hx-memory] [--profile web] [--since <ISO>] [--hours 24]
// 输出六个数, 判定规则写在最后一行:
//   1. profile 里是否选入 (dsh.profile.bundles 含 @hengxin666/hx-memory)
//   2. dist 是否含原话闸 (dist/capture/pipeline.js 引用 qualityOf; 插件从 dist 加载, 改 src 不重建 dist 等于没改)
//   3. 最近 N 小时 capture/ 账本行数 (按 outcome 分) 与最后一次时间
//   4. 最近 N 小时 schedule/ (pre-step) 账本行数
//   5. --since 之后新入库条目数, 及其中 kind=context 且 origin=raw (原话) 的条数
// 退出码: 0 = 判定正常; 3 = 未选入 (用户关闭, 不是故障); 1 = 选入但不正常; 2 = 参数/路径错误。
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FileBackend } from "../src/storage/file-store.ts";
import { qualityOf } from "../src/app/memory-quality.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const opt = (k: string): string | undefined => { const i = argv.indexOf("--" + k); return i >= 0 ? argv[i + 1] : undefined; };
const ROOT = resolve(opt("root") ?? process.env.HX_MEMORY_ROOT ?? join(homedir(), ".dsh", "hx-memory"));
const PKG = join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "profiles", opt("profile") ?? "web", "package.json");
const HOURS = Number(opt("hours") ?? "24");
const SINCE = opt("since") ? Date.parse(opt("since")!) : Date.now() - HOURS * 3600_000;
if (Number.isNaN(HOURS) || Number.isNaN(SINCE)) { console.error("--hours/--since 不合法"); process.exit(2); }
if (!existsSync(ROOT) || !existsSync(PKG)) { console.error("找不到记忆根或 profile: " + ROOT + " / " + PKG); process.exit(2); }

function parseAt(s: unknown): number {
  const t = String(s ?? "");
  const m = /(\d{4}-\d{2}-\d{2}) (\d{1,2}):(\d{2})(?::(\d{2}))? (AM|PM).*?UTC([+-]\d{2}):?(\d{2})/.exec(t);
  if (!m) return Date.parse(t);
  let h = Number(m[2]) % 12;
  if (m[5] === "PM") h += 12;
  return Date.parse(`${m[1]}T${String(h).padStart(2, "0")}:${m[3]}:${m[4] ?? "00"}${m[6]}:${m[7]}`);
}
function ledger(dir: string): { lines: number; byOutcome: Record<string, number>; last: number } {
  const r = { lines: 0, byOutcome: {} as Record<string, number>, last: 0 };
  const d = join(ROOT, dir);
  if (!existsSync(d)) return r;
  for (const f of readdirSync(d).filter((n) => n.endsWith(".jsonl"))) {
    if (statSync(join(d, f)).mtimeMs < SINCE) continue;
    for (const l of readFileSync(join(d, f), "utf8").split("\n")) {
      if (!l.trim()) continue;
      let o: any; try { o = JSON.parse(l); } catch { continue; }
      const at = parseAt(o.at);
      r.last = Math.max(r.last, at || 0);
      if (!(at >= SINCE)) continue;
      r.lines++;
      const k = String(o.outcome ?? "?");
      r.byOutcome[k] = (r.byOutcome[k] ?? 0) + 1;
    }
  }
  return r;
}

const p = JSON.parse(readFileSync(PKG, "utf8"));
const selected = ((p.dsh?.profile?.bundles ?? []) as string[]).includes("@hengxin666/hx-memory");
const distFile = join(REPO, "dist", "capture", "pipeline.js");
const distGate = existsSync(distFile) && readFileSync(distFile, "utf8").includes("qualityOf");
const cap = ledger("capture"), sch = ledger("schedule");
const fresh = new FileBackend({ root: ROOT }).all().filter((e) => Date.parse(e.ts?.assertedAt ?? "") >= SINCE);
const rawCtx = fresh.filter((e) => e.kind === "context" && qualityOf(e).origin === "raw").length;
const iso = (t: number) => (t ? new Date(t).toISOString() : "无");
console.log(`1 profile 选入: ${selected}  (${PKG})`);
console.log(`2 dist 含原话闸: ${distGate}  (${distFile})`);
console.log(`3 capture 账本 (自 ${iso(SINCE)}): ${cap.lines} 行 ${JSON.stringify(cap.byOutcome)}  最后一次 ${iso(cap.last)}`);
console.log(`4 schedule 账本 (pre-step): ${sch.lines} 行  最后一次 ${iso(sch.last)}`);
console.log(`5 新入库条目: ${fresh.length}, 其中原话 context: ${rawCtx}`);
let verdict: string, code: number;
if (!selected) { verdict = "未选入: 插件处于关闭状态 (用户选择), 不采集是预期"; code = 3; }
else if (!distGate) { verdict = "不正常: 已选入但 dist 是旧代码 (无原话闸), 先 pnpm run build 再重启 DSH"; code = 1; }
else if (cap.lines === 0 || sch.lines === 0) { verdict = "不正常: 已选入但窗口内 capture 或 schedule 账本无记录 (DSH 未重启 / 插件加载失败, 看 ~/.dsh/logs/startup-*.log)"; code = 1; }
else if (rawCtx > 0) { verdict = `不正常: 窗口内仍有 ${rawCtx} 条原话 context 入库 (原话闸没生效)`; code = 1; }
else { verdict = "正常: 已选入, dist 含闸, 账本有记录, 无原话 context 入库"; code = 0; }
console.log("判定: " + verdict);
process.exit(code);
