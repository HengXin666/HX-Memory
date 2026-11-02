// scripts/eval/report.ts — 评测可视化页: 读 eval-out/*.json, 生成单文件离线网页 docs/eval-report.html。
//
// 每个评测脚本 (frustration-detect / train-frustration / lesson-quality / kb-coverage / kb-sync / concurrency) 跑完都会调用
// writeReport(), 所以「跑完一次评测 ⇒ 页面就是最新的」, 直接用浏览器打开 docs/eval-report.html 即可, 不需要起服务。
// 页面只画 eval-out 里真实存在的数; 没有输出文件的指标显示为灰色斜纹「未测」, 不画占位数字。
//
// 单独重生成: node --experimental-strip-types --no-warnings scripts/eval/report.ts
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type J = Record<string, any>;

/** EVAL.md 第 1 节的指标目录 (名称与阈值文字照抄)。blocker = 第 4 节「能不能大规模用」的阻塞项。 */
export const CATALOG: ReadonlyArray<{ id: string; name: string; threshold: string; group: string; blocker?: boolean; script: string }> = [
  { id: "M1", name: "记忆命中率 Recall@5", threshold: ">= 0.80", group: "记忆", script: "memory-recall.ts" },
  { id: "M2", name: "记忆注入有用率", threshold: ">= 0.40", group: "记忆", script: "injection-utility.ts" },
  { id: "M3", name: "失效记忆泄漏率", threshold: "= 0", group: "记忆", blocker: true, script: "memory-recall.ts" },
  { id: "M4", name: "召回延迟 p95", threshold: "<= 15 ms (N=4000)", group: "记忆", script: "latency.ts" },
  { id: "M5", name: "并发写完整率", threshold: "= 1.00", group: "记忆", blocker: true, script: "concurrency.ts" },
  { id: "K1", name: "博客命中率 Hit@5", threshold: ">= 0.80", group: "知识库", script: "kb-retrieval.ts" },
  { id: "K2", name: "博客排序质量 MRR@10", threshold: ">= 0.60", group: "知识库", script: "kb-retrieval.ts" },
  { id: "K3", name: "博客入库覆盖率", threshold: "= 1.00", group: "知识库", blocker: true, script: "kb-coverage.ts" },
  { id: "K4", name: "博客同步延迟", threshold: "<= 60 s, 删除 0 残留", group: "知识库", script: "kb-sync.ts" },
  { id: "A1", name: "骂人检测召回率", threshold: ">= 0.90", group: "挫折", script: "frustration-detect.ts" },
  { id: "A2", name: "骂人检测误报率", threshold: "<= 0.05", group: "挫折", script: "frustration-detect.ts" },
  { id: "A3", name: "单条消息重复触发数", threshold: "= 1", group: "挫折", blocker: true, script: "frustration-detect.ts --replay" },
  { id: "C1", name: "纠正沉淀有效率", threshold: ">= 0.70", group: "挫折", script: "lesson-quality.ts" },
  { id: "C2", name: "同类错误复发率下降", threshold: ">= 0.50", group: "挫折", script: "correction-effect.ts" },
  { id: "C3", name: "同轮改正率", threshold: ">= 0.60", group: "挫折", script: "correction-effect.ts --same-turn" },
];

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const fmt = (v: unknown, d = 3) => (typeof v === "number" ? (Number.isInteger(v) ? String(v) : v.toFixed(d)) : v === null || v === undefined ? "—" : esc(v));

function load(dir: string): Map<string, J> {
  const m = new Map<string, J>();
  if (!existsSync(dir)) return m;
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith(".json")) continue;
    try {
      m.set(f.replace(/\.json$/, ""), JSON.parse(readFileSync(join(dir, f), "utf8")));
    } catch {
      /* 坏文件当作不存在 */
    }
  }
  return m;
}

export type State = "pass" | "fail" | "invalid" | "untested";

export function stateOf(j: J | undefined): State {
  if (!j) return "untested";
  if (j.valid === false || j.corpus === "builtin" || (j.value === null && j.n === 0)) return "invalid";
  if (j.pass === true) return "pass";
  return j.value === null || j.value === undefined ? "invalid" : "fail";
}

export const STATE_TEXT: Record<State, string> = { pass: "达标", fail: "未达标", invalid: "无效", untested: "未测" };

function card(c: (typeof CATALOG)[number], j: J | undefined): string {
  const st = stateOf(j);
  const val = j ? fmt(j.value) + (j.unit ? " " + esc(j.unit) : "") : "未测";
  const extra: string[] = [];
  if (j?.n !== undefined) extra.push("n = " + fmt(j.n));
  if (j?.confusion) extra.push(`TP ${j.confusion.tp} · FN ${j.confusion.fn} · FP ${j.confusion.fp} · TN ${j.confusion.tn}`);
  if (j?.invalidReasons?.length) extra.push("无效原因: " + j.invalidReasons.map(esc).join("; "));
  if (j?.corpus === "builtin") extra.push("内置小样例, 只验证机制, 不算正式结果");
  if (c.id === "A1" && j?.llmFreeRule) extra.push("按你的口径 (不用 LLM 即达标): " + (j.llmFreeRule.met ? "满足" : "不满足"));
  if (j?.method) extra.push("口径: " + esc(j.method));
  return `<div class="card ${st}"><div class="cid">${c.id}${c.blocker ? ' <span class="blk">阻塞项</span>' : ""}</div>
<div class="cname">${esc(c.name)}</div><div class="cval">${val}</div>
<div class="cthr">阈值 ${esc(c.threshold)} · <b>${STATE_TEXT[st]}</b></div>
${extra.map((e) => `<div class="cx">${e}</div>`).join("")}
<div class="cscript">${esc(c.script)}${j?.at ? " · " + esc(j.at) : ""}</div></div>`;
}

/** 候选对比: 召回 (带 95% 区间) 与误报率并排的横条图。 */
function candidatesSvg(t: J): string {
  const cs: J[] = t.candidates ?? [];
  const W = 760, rowH = 46, H = 40 + cs.length * rowH, x0 = 230, w = W - x0 - 20;
  const sx = (v: number) => x0 + v * w;
  let g = "";
  [0, 0.25, 0.5, 0.75, 1].forEach((v) => (g += `<line x1="${sx(v)}" x2="${sx(v)}" y1="22" y2="${H - 8}" class="grid"/><text x="${sx(v)}" y="16" class="ax">${v}</text>`));
  g += `<line x1="${sx(0.9)}" x2="${sx(0.9)}" y1="22" y2="${H - 8}" class="thr"/><text x="${sx(0.9) + 3}" y="${H - 10}" class="ax">A1 0.90</text>`;
  g += `<line x1="${sx(0.05)}" x2="${sx(0.05)}" y1="22" y2="${H - 8}" class="thr2"/><text x="${sx(0.05) + 3}" y="${H - 10}" class="ax">A2 0.05</text>`;
  cs.forEach((c, i) => {
    const y = 30 + i * rowH;
    const chosen = t.chosen?.id === c.id;
    g += `<text x="8" y="${y + 14}" class="lab${chosen ? " chosen" : ""}">${esc(c.id)} ${esc(c.name)}${chosen ? " ← 选中" : ""}</text>`;
    g += `<rect x="${x0}" y="${y}" width="${(c.recall ?? 0) * w}" height="14" class="bar-r"/>`;
    if (c.recallCI) g += `<line x1="${sx(c.recallCI[0])}" x2="${sx(c.recallCI[1])}" y1="${y + 7}" y2="${y + 7}" class="ci"/>`;
    g += `<text x="${sx(c.recall ?? 0) + 4}" y="${y + 12}" class="val">召回 ${fmt(c.recall)}</text>`;
    g += `<rect x="${x0}" y="${y + 17}" width="${(c.fpr ?? 0) * w}" height="14" class="bar-f${(c.fpr ?? 1) > 0.05 ? " over" : ""}"/>`;
    g += `<text x="${sx(c.fpr ?? 0) + 4}" y="${y + 29}" class="val">误报 ${fmt(c.fpr)}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img">${g}</svg>`;
}

/** 选中模型的权重 (前 24 个, 按 |权重|)。 */
function weightsSvg(weights: Record<string, number>): string {
  const ws = Object.entries(weights).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 24);
  if (!ws.length) return "";
  const max = Math.max(...ws.map(([, v]) => Math.abs(v)), 1e-9);
  const W = 760, rowH = 18, H = 10 + ws.length * rowH, mid = 470, half = 270;
  let g = `<line x1="${mid}" x2="${mid}" y1="0" y2="${H}" class="grid"/>`;
  ws.forEach(([k, v], i) => {
    const y = 6 + i * rowH, len = (Math.abs(v) / max) * half;
    g += `<text x="8" y="${y + 11}" class="lab">${esc(k)}</text>`;
    g += `<rect x="${v >= 0 ? mid : mid - len}" y="${y}" width="${len}" height="12" class="${v >= 0 ? "w-pos" : "w-neg"}"/>`;
    g += `<text x="${v >= 0 ? mid + len + 4 : mid - len - 4}" y="${y + 10}" class="val" text-anchor="${v >= 0 ? "start" : "end"}">${v}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img">${g}</svg>`;
}

function table(head: string[], rows: unknown[][]): string {
  return `<table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((c) => `<td>${typeof c === "number" ? fmt(c) : esc(c)}</td>`).join("")}</tr>`)
    .join("")}</tbody></table>`;
}

export function renderReport(out: Map<string, J>, generatedAt = new Date()): string {
  const blockers = CATALOG.filter((c) => c.blocker);
  const bStates = blockers.map((c) => stateOf(out.get(c.id)));
  const verdict = bStates.every((s) => s === "pass") ? "green" : bStates.some((s) => s === "fail") ? "red" : "yellow";
  const verdictText = {
    green: "阻塞项全部达标: 可以大规模用",
    red: "有阻塞项未达标: 不能大规模用",
    yellow: "阻塞项里还有未测 / 无效的: 现在还不能下结论",
  }[verdict];
  const counts = { pass: 0, fail: 0, invalid: 0, untested: 0 } as Record<State, number>;
  for (const c of CATALOG) counts[stateOf(out.get(c.id))]++;

  const groups = [...new Set(CATALOG.map((c) => c.group))];
  const header = `<header class="${verdict}"><h1>HX-Memory 评测</h1><div class="verdict">${verdictText}</div>
<div class="sum">阻塞项: ${blockers.map((c, i) => `${c.id} ${STATE_TEXT[bStates[i]!]}`).join(" · ")}</div>
<div class="sum">全部 15 项: 达标 ${counts.pass} · 未达标 ${counts.fail} · 无效 ${counts.invalid} · 未测 ${counts.untested}</div>
<div class="gen">生成于 ${esc(generatedAt.toISOString())} · 数据来自 eval-out/*.json · 每个评测脚本跑完自动重生成</div></header>`;
  let body = "";
  for (const gname of groups) {
    body += `<h2>${esc(gname)}</h2><div class="grid">${CATALOG.filter((c) => c.group === gname).map((c) => card(c, out.get(c.id))).join("")}</div>`;
  }

  const t = out.get("train");
  if (t) {
    body += `<h2>骂人检测选型 (不调用模型)</h2>
<p>样本 ${t.samples?.n} 条 (正例 ${t.samples?.pos}), ${t.samples?.sessions} 个会话, 样本哈希 <code>${esc(t.samples?.sha256)}</code>。口径: ${esc(t.protocol)}。
蓝条 = 召回 (横线是 95% 区间), 橙条 = 误报率 (红色 = 超过 0.05)。</p>${candidatesSvg(t)}
<p class="pick">选型: <b>${esc(t.chosen?.id)}</b> — ${esc(t.chosen?.why)}</p>`;
    body += table(
      ["候选", "召回", "召回 bootstrap 95%", "误报率", "误报率 bootstrap 95%", "TP", "FN", "FP", "TN", "特征数"],
      (t.candidates ?? []).map((c: J) => [c.id + " " + c.name, c.recall, c.boot ? `${fmt(c.boot.recall[0])}–${fmt(c.boot.recall[1])}` : c.recallCI ? `${fmt(c.recallCI[0])}–${fmt(c.recallCI[1])}` : "—", c.fpr, c.boot ? `${fmt(c.boot.fpr[0])}–${fmt(c.boot.fpr[1])}` : "—", c.tp, c.fn, c.fp, c.tn, c.features ?? "—"]),
    );
    if (t.selectionRule) body += `<p>选型规则: <code>${esc(t.selectionRule)}</code>; 字面「上界 &lt;= 0.05」规则下存活: ${esc((t.literalUpperRuleSurvivors ?? []).join(", ") || "无")}。</p>`;
    if (t.posterior?.length) body += `<h3>后验口径 (离线, 实时路 OR 助手下一条首句以「你说得对」开头; 不进模型)</h3>` + table(
      ["候选", "召回", "召回 bootstrap 95%", "误报率", "误报率 bootstrap 95%", "补回条数"],
      t.posterior.map((p: J) => [p.id, p.recall, `${fmt(p.boot.recall[0])}–${fmt(p.boot.recall[1])}`, p.fpr, `${fmt(p.boot.fpr[0])}–${fmt(p.boot.fpr[1])}`, p.addedHits?.length ?? 0]),
    );
    if (t.model?.weights) body += `<h3>当前模型的权重 (前 24 个)</h3><p>阈值 ${fmt(t.model.threshold, 4)}, 偏置 ${fmt(t.model.bias, 4)}。每次判定的得分 = 偏置 + 命中特征的权重之和。</p>${weightsSvg(t.model.weights)}`;
  }
  const a1 = out.get("A1"), a2 = out.get("A2");
  if (a1?.misses?.length) body += `<h3>漏判 (A1, 前 30 条)</h3>` + table(["sid", "标签", "原文"], a1.misses.slice(0, 30).map((m: J) => [m.sid, m.label, m.text]));
  if (a2?.falseAlarms?.length) body += `<h3>误报 (A2)</h3>` + table(["sid", "命中", "得分", "原文"], a2.falseAlarms.map((m: J) => [m.sid, (m.matched ?? []).join(" / "), m.score ?? "—", m.text]));
  if (a1?.byLabel) body += `<h3>按标签的命中</h3>` + table(["标签", "条数", "命中"], Object.entries(a1.byLabel).map(([k, v]: [string, any]) => [k, v.n, v.hit]));

  const k3 = out.get("K3");
  if (k3?.perDir) {
    body += `<h2>知识库同步明细</h2><h3>K3 按目录</h3>` + table(["目录", "文件数", "入库", "覆盖率"], Object.entries(k3.perDir).map(([d, v]: [string, any]) => [d, v.files, v.covered, v.files ? v.covered / v.files : null]));
    const fr = Object.entries(k3.failedByReason ?? {});
    if (fr.length) body += `<h3>K3 失败清单 (按原因)</h3>` + table(["原因", "个数", "例子"], fr.map(([r, fs]: [string, any]) => [r, fs.length, fs.slice(0, 5).join(", ")]));
  }
  const k4 = out.get("K4");
  if (k4?.actions) body += `<h3>K4 每个动作的延迟</h3><p>轮询间隔 ${fmt(k4.intervalMs)} ms, 首轮全量 ${fmt(k4.initialSyncMs)} ms, 语料 ${esc(k4.corpus)}。</p>` + table(["动作", "文件", "秒", "残留"], k4.actions.map((a: J) => [a.action, a.file, a.seconds ?? "超时", a.residual ?? "—"]));

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>HX-Memory 评测</title><style>
body{font:14px/1.55 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;margin:0;background:#f6f7f9;color:#1d2330}
main{max-width:1080px;margin:0 auto;padding:0 20px 60px}
header{padding:22px 20px;color:#fff;margin-bottom:8px}header.green{background:#1f8a4c}header.red{background:#b42318}header.yellow{background:#b7791f}
header h1{margin:0 0 6px;font-size:22px}.verdict{font-size:18px;font-weight:600}.sum,.gen{opacity:.92;font-size:13px}
h2{margin:28px 0 10px;font-size:18px}h3{margin:20px 0 8px;font-size:15px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px}
.card{background:#fff;border-radius:10px;padding:12px 14px;border-left:6px solid #999;box-shadow:0 1px 2px #0001}
.card.pass{border-color:#1f8a4c}.card.fail{border-color:#b42318}.card.invalid{border-color:#b7791f}
.card.untested{border-color:#9aa1ad;background:repeating-linear-gradient(45deg,#fff,#fff 8px,#eef0f3 8px,#eef0f3 16px)}
.cid{font-weight:700;color:#556}.blk{font-size:11px;background:#1d2330;color:#fff;border-radius:4px;padding:0 5px;margin-left:4px}
.cname{font-size:13px;color:#445}.cval{font-size:26px;font-weight:700;margin:4px 0}.cthr{font-size:12px;color:#556}
.cx{font-size:12px;color:#334;margin-top:4px;word-break:break-all}.cscript{font-size:11px;color:#889;margin-top:6px}
.chart{width:100%;background:#fff;border-radius:10px;padding:6px 0}.grid line{stroke:#e3e6ea}
line.grid{stroke:#e3e6ea}line.thr{stroke:#1f6feb;stroke-dasharray:4 3}line.thr2{stroke:#d97706;stroke-dasharray:4 3}
.ax{font-size:11px;fill:#778;text-anchor:middle}.lab{font-size:12px;fill:#223}.lab.chosen{font-weight:700}.val{font-size:11px;fill:#334}
.bar-r{fill:#3b82f6}.bar-f{fill:#f59e0b}.bar-f.over{fill:#dc2626}line.ci{stroke:#1e3a8a;stroke-width:2}.w-pos{fill:#3b82f6}.w-neg{fill:#9ca3af}
table{border-collapse:collapse;width:100%;background:#fff;border-radius:10px;overflow:hidden;font-size:13px}
th,td{padding:6px 10px;border-bottom:1px solid #eef0f3;text-align:left;vertical-align:top}th{background:#f0f2f5}
.pick{background:#fff;border-radius:8px;padding:8px 12px}code{background:#eef0f3;padding:0 4px;border-radius:3px}
</style></head><body>${header}<main>${body}</main></body></html>`;
}

/** 读 <repo>/eval-out, 写 <repo>/docs/eval-report.html。任何错误只打印, 不让评测脚本失败。 */
export function writeReport(repo: string): string | null {
  try {
    const html = renderReport(load(join(repo, "eval-out")));
    mkdirSync(join(repo, "docs"), { recursive: true });
    const file = join(repo, "docs", "eval-report.html");
    writeFileSync(file, html);
    console.log("评测页已重生成: " + file);
    return file;
  } catch (e) {
    console.error("评测页生成失败 (不影响评测结果): " + String(e));
    return null;
  }
}

if (import.meta.url === "file://" + process.argv[1]) {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  process.exitCode = writeReport(repo) ? 0 : 3;
}
