// scripts/panel-app.tsx — HX-Memory 面板前端 (构建时暂存为 src/App.tsx)。
// 每一页只读 scripts/panel-server.ts 的 /api/*; 请求一律相对路径 "api/...", 经 HX-WebX 的 /proxy/<name>/ 同样可用。
// 页面 ↔ 接口:
//   总览    GET overview (两个池子分开计数 + 15 个指标 + hook 结论)
//   Hook    GET hooks (开关来源 + pre-step / capture / review 账本)
//   记忆    GET memory/banks, memory/recent, memory/list, memory/search, memory/entry
//   时间衰减 GET decay (曲线 / 参数 / 推导 / 每条的有效置信度 / 常驻注入改前改后)
//   知识库  GET kb, kb/files; POST kb, kb/sync; DELETE kb; 清空 DELETE kb/purge (二次确认) + GET kb/purge (进度)
//   记忆质量 GET memory/quality; 记忆页两池 GET memory/recent?pool=derived|raw
//   检测    POST detect      评估 GET eval      模型 GET/PUT model, POST model/test
import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  Alert, AlertDescription, AlertTitle, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle,
  DataTable, Input, NavTabs, PageHeader, StatCard, StatGrid, Textarea,
} from "./ui.ts";

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

async function call<T = Json>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const r = await fetch("api/" + path, {
    method: init?.method ?? "GET",
    headers: init?.body === undefined ? {} : { "content-type": "application/json" },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const j = await r.json().catch(() => ({ ok: false, error: "HTTP " + r.status }));
  if (!j.ok) throw new Error(j.error ?? "HTTP " + r.status);
  return j.data as T;
}

function useLoad<T = Json>(path: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const reload = useCallback(() => {
    setError("");
    call<T>(path).then(setData, (e: Error) => setError(e.message));
  }, [path]);
  useEffect(reload, [reload]);
  return { data, error, reload };
}

const fmt = (n: unknown, d = 3) => (typeof n === "number" ? n.toFixed(d) : String(n ?? "—"));
const when = (s: unknown) => (s ? new Date(String(s)).toLocaleString() : "—");
const Muted = ({ children }: { children: ReactNode }) => <p className="text-sm text-muted-foreground">{children}</p>;
const Loading = () => <Muted>加载中…</Muted>;

function Err({ msg }: { msg: string }) {
  return msg ? (
    <Alert variant="danger">
      <AlertTitle>请求失败</AlertTitle>
      <AlertDescription>{msg}</AlertDescription>
    </Alert>
  ) : null;
}

function Section({ title, desc, children, right }: { title: string; desc?: ReactNode; children: ReactNode; right?: ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle>{title}</CardTitle>
            {desc ? <CardDescription>{desc}</CardDescription> : null}
          </div>
          {right}
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">{children}</CardContent>
    </Card>
  );
}

const Counts = ({ m, variant = "secondary" }: { m: Record<string, number> | undefined; variant?: "secondary" | "outline" }) => (
  <div className="flex flex-wrap gap-2">
    {Object.entries(m ?? {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => <Badge key={k} variant={variant}>{k} {v}</Badge>)}
  </div>
);

const Text = ({ t }: { t: string }) => <span className="whitespace-pre-wrap break-words">{t}</span>;

// ---------------- 总览 ----------------
// ---------------- 采集插件三态 (2026-11-01; 根因见 COLLECT-BROKEN.md) ----------------
// 已关闭是用户的选择: 标灰写原因, 不报警。只有「启用了却没数据」才是异常。
const PLUGIN_STATE: Record<string, { badge: string; text: string; alert: string }> = {
  "enabled-active": { badge: "success", text: "已启用且在采集", alert: "success" },
  "closed-by-user": { badge: "secondary", text: "已关闭 (用户主动)", alert: "default" },
  "enabled-no-data": { badge: "destructive", text: "已启用但没有数据 (异常)", alert: "danger" },
  "not-installed": { badge: "outline", text: "未安装", alert: "default" },
  unknown: { badge: "outline", text: "读不到 profile", alert: "warning" },
};
function PluginState({ p }: { p: Json }) {
  if (!p) return null;
  const s = PLUGIN_STATE[p.state] ?? PLUGIN_STATE.unknown;
  const closed = p.state === "closed-by-user";
  return (
    <Alert variant={s.alert as never} className={closed ? "opacity-70" : undefined}>
      <AlertTitle><Badge variant={s.badge as never}>{s.text}</Badge></AlertTitle>
      <AlertDescription>
        {closed ? <div>关闭原因: {p.closeNote}</div> : null}
        <div>{p.verdict}</div>
        <div className="text-xs text-muted-foreground">profile {p.profile} · 依赖 {p.installed ? "在" : "不在"} · 在 dsh.profile.bundles {p.selected ? "是" : "否"} · 最后一次采集 {when(p.lastCapture)}</div>
      </AlertDescription>
    </Alert>
  );
}

// ---------------- 沉淀质量 (2026-11-01; 判据见 src/app/memory-quality.ts) ----------------
const ORIGIN_BADGE: Record<string, string> = { derived: "success", raw: "outline", kb: "secondary" };
function QualityCell({ q }: { q: Json }) {
  if (!q) return null;
  return (
    <div className="flex flex-wrap items-center gap-1">
      <Badge variant={ORIGIN_BADGE[q.origin] as never}>{q.originLabel}</Badge>
      {q.refined ? <Badge variant="secondary">已提炼{q.refineMarks?.length ? " · " + q.refineMarks.join("/") : ""}</Badge> : <Badge variant="outline">未提炼</Badge>}
      <span className={q.low ? "text-xs text-warning-fg" : "text-xs text-muted-foreground"}>{q.length} 字{q.low ? " (低质)" : ""}</span>
    </div>
  );
}

function QualityOverview() {
  const { data, error, reload } = useLoad("memory/quality");
  if (error) return <Err msg={error} />;
  if (!data) return <Loading />;
  const pct = (a: number, b: number) => (b ? ((a / b) * 100).toFixed(1) + "%" : "—");
  const REASON: Record<string, string> = { short: "不足 40 字", filler: "纯指令 / 附和", command: "命令 / 链接 / 路径", conversational: "对助手说话的口吻", unstructured: "无结构原文" };
  return (
    <Section title="沉淀质量总览" desc="回答「沉淀的效果怎么样」: 推导出的沉淀和用户原话分开算。只统计对话沉淀, 知识库切片不算。" right={<Button size="sm" variant="outline" onClick={reload}>刷新</Button>}>
      <Alert variant={data.context.rawShare > 30 ? "warning" : "info"}><AlertTitle>{data.verdict}</AlertTitle><AlertDescription>{data.criteria.rule}</AlertDescription></Alert>
      <StatGrid columns={4}>
        <StatCard label="推导出的沉淀" value={data.derived} hint={pct(data.derived, data.total)} tone="good" />
        <StatCard label="用户原话" value={data.raw} hint={pct(data.raw, data.total)} tone={data.raw ? "bad" : "default"} />
        <StatCard label={`≤${data.criteria.lowLen} 字低质`} value={data.low} hint={pct(data.low, data.total)} />
        <StatCard label="知识库切片 (不计入)" value={data.kb} tone="muted" />
      </StatGrid>
      <DataTable bare rows={Object.entries(data.byKind).map(([kind, v]: [string, Json]) => ({ kind, ...v }))} rowKey={(r: Json) => r.kind} columns={[
        { key: "kind", header: "类型" },
        { key: "total", header: "条数", numeric: true },
        { key: "share", header: "占比", numeric: true, render: (r: Json) => pct(r.total, data.total) },
        { key: "derived", header: "沉淀", numeric: true },
        { key: "raw", header: "原话", numeric: true },
        { key: "low", header: "≤20 字", numeric: true },
      ]} />
      <div className="flex flex-wrap gap-2">
        {Object.entries(data.rawByReason).map(([k, v]) => <Badge key={k} variant="outline">原话 · {REASON[k] ?? k} {String(v)}</Badge>)}
      </div>
    </Section>
  );
}

function Overview() {
  const { data, error, reload } = useLoad("overview");
  if (error) return <Err msg={error} />;
  if (!data) return <Loading />;
  const st = data.stats;
  const ms = data.metrics;
  return (
    <div className="flex flex-col gap-4">
      {data.stackError ? <Err msg={"记忆根打不开: " + data.stackError} /> : null}
      <StatGrid columns={4}>
        <StatCard label="对话沉淀" value={st.dialog.total} hint={st.dialog.from} />
        <StatCard label="知识库切片" value={st.kb.total} hint="只在检索时按需返回, 不进每轮注入" tone="muted" />
        <StatCard label="规则 (active / 全部)" value={`${st.rules.active} / ${st.rules.entries}`} hint={`rules/*.md ${st.rules.files} 个`} />
        <StatCard label="采集插件" value={(PLUGIN_STATE[data.hook.plugin?.state] ?? PLUGIN_STATE.unknown).text} hint={data.hook.verdict} tone={data.hook.plugin?.state === "enabled-active" ? "good" : data.hook.plugin?.state === "closed-by-user" ? "muted" : "bad"} />
      </StatGrid>
      <PluginState p={data.hook.plugin} />
      <Section title="对话沉淀 (按类型 / 状态)" right={<Button size="sm" variant="outline" onClick={reload}>刷新</Button>} desc={data.memoryRoot}>
        <Counts m={st.dialog.byKind} />
        <Counts m={st.dialog.byStatus} variant="outline" />
      </Section>
      <Section title="知识库" desc={data.kbNote}>
        {st.kb.total ? <Counts m={st.kb.bySource} /> : <Muted>记忆根里没有知识库切片。</Muted>}
      </Section>
      <Section title="评估指标" desc={`通过 ${ms.summary.pass} · 失败 ${ms.summary.fail} · 无效 ${ms.summary.invalid} · 未测 ${ms.summary.untested} · 最近一次 ${when(ms.lastEvalAt)} (${ms.lastEvalFile || "—"})`}>
        <DataTable rows={ms.rows} rowKey={(r: Json) => r.id} maxHeight="28rem" columns={[
          { key: "id", header: "ID" },
          { key: "name", header: "指标" },
          { key: "state", header: "状态", render: (r: Json) => <Badge variant={r.state === "pass" ? "success" : r.state === "fail" ? "destructive" : "outline"}>{r.stateText}</Badge> },
          { key: "value", header: "值", numeric: true, render: (r: Json) => fmt(r.value) },
          { key: "threshold", header: "门槛" },
          { key: "n", header: "样本", numeric: true },
          { key: "at", header: "时间", render: (r: Json) => when(r.at) },
        ]} />
      </Section>
    </div>
  );
}

// ---------------- Hook ----------------
function Hooks() {
  const { data, error, reload } = useLoad("hooks?n=30");
  if (error) return <Err msg={error} />;
  if (!data) return <Loading />;
  const L = data.ledgers;
  const closed = data.plugin?.state === "closed-by-user";
  // 插件被用户关掉时, 账本停更是预期: 灰色, 不标黄。
  const age = (h: number | null) => (h === null ? <Badge variant="outline">无记录</Badge> : h <= 24 ? <Badge variant="success">{h} 小时前</Badge> : <Badge variant={closed ? "secondary" : "warning"}>{h} 小时前</Badge>);
  return (
    <div className="flex flex-col gap-4">
      <PluginState p={data.plugin} />
      <div className="flex flex-wrap gap-2 text-xs">
        {(["enabled-active", "closed-by-user", "enabled-no-data"] as const).map((k) => (
          <span key={k} className={data.plugin?.state === k ? "rounded border-2 border-foreground px-2 py-1" : "rounded border px-2 py-1 opacity-50"}>
            <Badge variant={PLUGIN_STATE[k].badge as never}>{PLUGIN_STATE[k].text}</Badge>{" "}
            {{ "enabled-active": "正常", "closed-by-user": "灰色, 不报警: 用户的选择, 账本停更是预期", "enabled-no-data": "红色报警: 启用了却 24 小时无记录" }[k]}
            {data.plugin?.state === k ? " ← 当前" : ""}
          </span>
        ))}
      </div>
      <Muted>{data.verdict} · 判据: 24 小时内 schedule/ (pre-step) 或 capture/ (入库) 账本有新记录。记忆根 {data.memoryRoot}</Muted>
      <StatGrid columns={3}>
        {(["preStep", "capture", "review"] as const).map((k) => (
          <StatCard key={k} label={{ preStep: "pre-step 注入", capture: "捕获入库", review: "复核队列" }[k]} value={L[k].lines} hint={<span>{L[k].dir} · 最近 {age(L[k].ageHours)}</span>} />
        ))}
      </StatGrid>
      <Section title="开关" desc={data.settingsSectionFound ? data.settingsFile + " 里有 hx-memory 段" : data.settingsFile + " 里没有 hx-memory 段, 全部用默认值"} right={<Button size="sm" variant="outline" onClick={reload}>刷新</Button>}>
        <DataTable bare rows={data.switches} rowKey={(r: Json) => r.key} columns={[
          { key: "key", header: "开关" },
          { key: "value", header: "值", render: (r: Json) => <Badge variant="outline">{r.value}</Badge> },
          { key: "from", header: "来源" },
        ]} />
        <Muted>DSH hooks 目录: {data.dshHookFiles.length ? data.dshHookFiles.join(", ") : "(空)"}</Muted>
      </Section>
      <Section title="最近的 pre-step 注入">
        <DataTable bare rows={data.preStep} rowKey={(_r: Json, i) => i} emptyText="账本为空" maxHeight="24rem" columns={[
          { key: "at", header: "时间", render: (r: Json) => when(r.at) },
          { key: "project", header: "项目" },
          { key: "channel", header: "通道" },
          { key: "outcome", header: "结果" },
          { key: "ids", header: "条数", numeric: true },
          { key: "tokens", header: "tokens", numeric: true },
          { key: "reason", header: "原因", render: (r: Json) => <Text t={r.reason} /> },
        ]} />
      </Section>
      <Section title="最近的捕获">
        <DataTable bare rows={data.capture} rowKey={(_r: Json, i) => i} emptyText="账本为空" maxHeight="24rem" columns={[
          { key: "at", header: "时间", render: (r: Json) => when(r.at) },
          { key: "project", header: "项目" },
          { key: "outcome", header: "结果" },
          { key: "skip", header: "跳过原因" },
          { key: "entries", header: "条目", numeric: true },
          { key: "totalMs", header: "ms", numeric: true },
        ]} />
      </Section>
    </div>
  );
}

// ---------------- 记忆 ----------------
function Memory() {
  const banks = useLoad("memory/banks");
  const derivedPool = useLoad("memory/recent?pool=derived&limit=50");
  const rawPool = useLoad("memory/recent?pool=raw&limit=50");
  const [bank, setBank] = useState("");
  const [q, setQ] = useState("");
  const [excludeKb, setExcludeKb] = useState(true);
  const [res, setRes] = useState<Json>(null);
  const [err, setErr] = useState("");
  const [entry, setEntry] = useState<Json>(null);
  const search = () => {
    setErr("");
    call("memory/search?q=" + encodeURIComponent(q) + "&excludeKb=" + (excludeKb ? "1" : "0") + (bank ? "&bank=" + encodeURIComponent(bank) : "")).then(setRes, (e: Error) => setErr(e.message));
  };
  const open = (id: string, b: string) => call("memory/entry?id=" + encodeURIComponent(id) + "&bank=" + encodeURIComponent(b)).then(setEntry, (e: Error) => setErr(e.message));
  const hitCols = [
    { key: "score", header: "分数", numeric: true, render: (r: Json) => fmt(r.score) },
    { key: "channels", header: "通道", render: (r: Json) => r.channels.join(", ") },
    { key: "why", header: "依据", render: (r: Json) => <span className={r.why.includes("superseded-by") ? "text-warning-fg" : ""}>{r.why}</span> },
    { key: "text", header: "内容", render: (r: Json) => <Text t={r.text} /> },
  ];
  return (
    <div className="flex flex-col gap-4">
      <QualityOverview />
      <Section title="记忆库" desc="按项目 / scope 分组; 知识库切片不在这里, 在「知识库」页。">
        <Err msg={banks.error} />
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant={bank ? "outline" : "primary"} onClick={() => setBank("")}>全部</Button>
          {(banks.data?.banks ?? []).map((b: Json) => (
            <Button key={b.id} size="sm" variant={bank === b.id ? "primary" : "outline"} onClick={() => setBank(b.id)}>{b.label} {b.total}</Button>
          ))}
        </div>
      </Section>
      <Section title="检索" desc="facade.recall (purpose=recall), 与线上同一个混合检索器。被同话题新条目压住的会在「依据」里标 superseded-by。">
        <SemanticNotice />
        <div className="flex flex-wrap items-center gap-2">
          <Input className="min-w-[20rem] flex-1" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && q.trim() && search()} placeholder="输入要召回的内容" />
          <label className="flex items-center gap-1 text-sm"><input type="checkbox" checked={excludeKb} onChange={(e) => setExcludeKb(e.target.checked)} />排除知识库</label>
          <Button variant="primary" onClick={search} disabled={!q.trim()}>检索</Button>
        </div>
        <Err msg={err} />
        {res ? (
          <>
            <Muted>tokens {res.tokens} · degraded {JSON.stringify(res.degraded)}{res.excludeKb ? ` · 知识库命中 ${res.kbExcluded} 条已排除` : ""}</Muted>
            {Object.keys(res.groups).length === 0 ? <Muted>对话沉淀里没有命中。</Muted> : null}
            {Object.entries(res.groups).map(([kind, rows]) => (
              <div key={kind} className="flex flex-col gap-1">
                <Badge variant="secondary">{kind} · {(rows as Json[]).length}</Badge>
                <DataTable bare rows={rows as Json[]} rowKey={(r: Json) => r.id} onRowClick={(r: Json) => open(r.id, r.bank)} columns={hitCols} />
              </div>
            ))}
            {res.kb.length ? <details><summary className="cursor-pointer text-sm">知识库命中 {res.kb.length} 条</summary><DataTable bare rows={res.kb} rowKey={(r: Json) => r.id} columns={hitCols} /></details> : null}
          </>
        ) : null}
      </Section>
      {entry ? (
        <Section title={"条目 " + entry.entry.id} right={<Button size="sm" variant="ghost" onClick={() => setEntry(null)}>关闭</Button>} desc={`${entry.entry.kind} · ${entry.entry.status ?? "active"} · ${entry.entry.source ?? ""}`}>
          <Text t={entry.entry.content ?? entry.entry.text ?? ""} />
          {entry.related?.length ? <DataTable bare rows={entry.related} rowKey={(r: Json, i) => r.toId + i} columns={[{ key: "type", header: "关系" }, { key: "kind", header: "类型" }, { key: "text", header: "对方" }]} /> : null}
        </Section>
      ) : null}
      <div className="grid gap-4 xl:grid-cols-2">
        {([["derived", "沉淀物 (最近 50 条)", "lesson / decision / pattern / fact / preference / rule, 以及够格的 context (判据见上)。这才是推导出来的记忆。", derivedPool], ["raw", "原始对话 (最近 50 条)", "用户原话被原样存下的 context: 不删, 只标出来; 删不删由你定。", rawPool]] as const).map(([k, title, desc, pool]) => (
          <Section key={k} title={title} desc={desc}>
            <Err msg={pool.error} />
            <DataTable rows={pool.data?.items ?? []} loading={!pool.data && !pool.error} rowKey={(r: Json) => r.id} maxHeight="40rem" onRowClick={(r: Json) => open(r.id, r.bank)} columns={[
              { key: "at", header: "时间", render: (r: Json) => when(r.at) },
              { key: "kind", header: "类型" },
              { key: "quality", header: "沉淀质量", render: (r: Json) => <QualityCell q={r.quality} /> },
              { key: "text", header: "内容", render: (r: Json) => <Text t={r.text} /> },
            ]} />
          </Section>
        ))}
      </div>
    </div>
  );
}

// ---------------- 时间衰减 ----------------
const KIND_COLOR: Record<string, string> = { rule: "#e5484d", decision: "#f5a524", preference: "#a78bfa", fact: "#3b82f6", lesson: "#22c55e", pattern: "#14b8a6", context: "#94a3b8", event: "#64748b" };

/** 保持率曲线: 纯 SVG (不引图表库, 宿主的构建依赖里没有)。横轴按 √天 压缩, 让 0~30 天看得清。 */
function CurveChart({ curve }: { curve: Array<{ kind: string; points: Array<[number, number]> }> }) {
  const [hover, setHover] = useState<string | null>(null);
  const W = 760, H = 300, L = 44, R = 110, T = 12, B = 34;
  const maxD = 365;
  const x = (d: number) => L + (Math.sqrt(d) / Math.sqrt(maxD)) * (W - L - R);
  const y = (r: number) => T + (1 - r) * (H - T - B);
  const lines = curve.filter((c) => c.kind !== "doc");
  // 右侧标签按末端值排开, 至少隔 13px, 免得末端相近的几条叠在一起。
  const labelY = new Map<string, number>();
  let prev = -Infinity;
  for (const c of [...lines].sort((a, b) => b.points[b.points.length - 1]![1] - a.points[a.points.length - 1]![1])) {
    const want = y(c.points[c.points.length - 1]![1]) + 4;
    prev = Math.max(want, prev + 13);
    labelY.set(c.kind, prev);
  }
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="保持率曲线">
      {[0, 0.25, 0.5, 0.75, 1].map((r) => (
        <g key={r}>
          <line x1={L} x2={W - R} y1={y(r)} y2={y(r)} stroke="currentColor" strokeOpacity={0.12} />
          <text x={L - 6} y={y(r) + 4} fontSize={11} textAnchor="end" fill="currentColor" opacity={0.6}>{r}</text>
        </g>
      ))}
      {[0, 1, 7, 30, 90, 180, 365].map((d) => (
        <g key={d}>
          <line x1={x(d)} x2={x(d)} y1={T} y2={H - B} stroke="currentColor" strokeOpacity={d === 1 || d === 365 ? 0.35 : 0.08} strokeDasharray={d === 1 || d === 365 ? "4 3" : undefined} />
          <text x={x(d)} y={H - B + 16} fontSize={11} textAnchor={d === 365 ? "end" : "middle"} fill="currentColor" opacity={0.7}>{d === 1 ? "昨天" : d === 365 ? "去年" : d + "天"}</text>
        </g>
      ))}
      {lines.map((c) => {
        const normative = ["rule", "decision", "preference"].includes(c.kind);
        const dim = hover !== null && hover !== c.kind;
        const pts = c.points.filter(([d]) => d <= maxD);
        const last = pts[pts.length - 1]!;
        return (
          <g key={c.kind} onMouseEnter={() => setHover(c.kind)} onMouseLeave={() => setHover(null)} opacity={dim ? 0.2 : 1}>
            <polyline fill="none" stroke={KIND_COLOR[c.kind] ?? "#888"} strokeWidth={normative ? 2.5 : 1.3} points={pts.map(([d, r]) => `${x(d)},${y(r)}`).join(" ")} />
            {normative ? pts.filter(([d]) => d === 1 || d === 365).map(([d, r]) => <circle key={d} cx={x(d)} cy={y(r)} r={3} fill={KIND_COLOR[c.kind]}><title>{`${c.kind} ${d} 天: ${r}`}</title></circle>) : null}
            <text x={W - R + 6} y={labelY.get(c.kind)} fontSize={11} fill={KIND_COLOR[c.kind] ?? "#888"}>{c.kind} {last[1]}</text>
          </g>
        );
      })}
    </svg>
  );
}

// 每条记忆的打分 (后端 decayView.scored: 与线上排序同一套 src/kernel/temporal.ts 函数, 不是静态说明)。
function DecayScored({ rows, now }: { rows: Json[]; now: string }) {
  const [kind, setKind] = useState("");
  const [origin, setOrigin] = useState("");
  const kinds = [...new Set(rows.map((r) => r.kind))].sort();
  const shown = rows.filter((r) => (!kind || r.kind === kind) && (!origin || r.origin === origin));
  return (
    <Section title="每条记忆的打分" desc={`共 ${rows.length} 条 active 对话沉淀, 按最终分降序; 计算时刻 ${when(now)}。最终分 = 初始置信度 × 保持率 R × (被压 ? 0.1 : 1)。`}>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant={kind ? "outline" : "primary"} onClick={() => setKind("")}>全部类型</Button>
        {kinds.map((k) => <Button key={k} size="sm" variant={kind === k ? "primary" : "outline"} onClick={() => setKind(k)}>{k}</Button>)}
        <span className="mx-2" />
        {[["", "全部来源"], ["derived", "推导出的沉淀"], ["raw", "用户原话"]].map(([k, l]) => <Button key={k} size="sm" variant={origin === k ? "primary" : "outline"} onClick={() => setOrigin(k)}>{l}</Button>)}
      </div>
      <DataTable rows={shown} rowKey={(r: Json) => r.id} maxHeight="40rem" columns={[
        { key: "kind", header: "类型", render: (r: Json) => <Badge variant="outline">{r.kind}</Badge> },
        { key: "assertedAt", header: "断言日期", render: (r: Json) => String(r.assertedAt).slice(0, 10) },
        { key: "ageDays", header: "距今 (天)", numeric: true },
        { key: "halfLifeDays", header: "半衰期 H", numeric: true, render: (r: Json) => (r.halfLifeDays === null ? "∞" : r.halfLifeDays) },
        { key: "floor", header: "地板", numeric: true },
        { key: "retention", header: "保持率 R", numeric: true, render: (r: Json) => fmt(r.retention) },
        { key: "confidence0", header: "初始置信度", numeric: true, render: (r: Json) => fmt(r.confidence0) },
        { key: "score", header: "最终分", numeric: true, render: (r: Json) => <span className={r.superseded ? "text-warning-fg" : ""}>{fmt(r.score)}{r.superseded ? " (被压)" : ""}</span> },
        { key: "origin", header: "来源", render: (r: Json) => <Badge variant={ORIGIN_BADGE[r.origin] as never}>{r.originLabel}</Badge> },
        { key: "text", header: "内容", render: (r: Json) => <Text t={r.text} /> },
      ]} />
    </Section>
  );
}

function Decay() {
  const [project, setProject] = useState("");
  const { data, error, reload } = useLoad("decay" + (project ? "?project=" + encodeURIComponent(project) : ""));
  if (error) return <Err msg={error} />;
  if (!data) return <Loading />;
  const der = data.derivation;
  return (
    <div className="flex flex-col gap-4">
      <Alert variant="info">
        <AlertTitle>有效置信度 = 初始置信度 × R(age) × (被同话题新条目压住 ? {data.supersede.factor} : 1)</AlertTitle>
        <AlertDescription>
          R(age) = floor + (1 − floor) · 2^(−age / H)。age 从用户最后一次断言它算起 (validAt 与 confirmedAt 取晚的), 不看被注入/被检索的时间。
          同话题判据: 重合系数 ≥ {data.supersede.strong}, 或 ≥ {data.supersede.overlap} 且新的一条带改写信号 (改为/不再/以后…)。当前被压 {data.supersede.count} 条。
        </AlertDescription>
      </Alert>
      <Section title="保持率曲线 R(age)" desc="横轴: 距用户断言的天数; 纵轴: 排序权重里的时间系数。规则一年后落到地板 (不消失, 只排后面)。">
        <CurveChart curve={data.curve} />
        <DataTable bare rows={data.pair} rowKey={(r: Json) => r.ageDays} columns={[
          { key: "ageDays", header: "断言距今 (天)", numeric: true },
          { key: "rule", header: "rule R", numeric: true, render: (r: Json) => fmt(r.rule) },
          { key: "decision", header: "decision R", numeric: true, render: (r: Json) => fmt(r.decision) },
          { key: "preference", header: "preference R", numeric: true, render: (r: Json) => fmt(r.preference) },
        ]} />
        <Muted>昨天定的规则 R={fmt(data.pair[0].rule)}, 去年定的 R={fmt(data.pair[4].rule)}: 同 importance 时前者排序分是后者的 {(data.pair[0].rule / data.pair[4].rule).toFixed(1)} 倍; 若两条同话题且新的在改写旧的, 旧的再 ×{data.supersede.factor} 并退出常驻注入。</Muted>
      </Section>
      <Section title="参数 (按 kind)" desc="规范性 kind 参与「同话题新压旧」, 且命中次数不再延长寿命。">
        <DataTable bare rows={data.params} rowKey={(r: Json) => r.kind} columns={[
          { key: "kind", header: "kind" },
          { key: "halfLifeDays", header: "半衰期 H (天)", numeric: true, render: (r: Json) => (r.halfLifeDays === null ? "∞" : r.halfLifeDays) },
          { key: "floor", header: "地板", numeric: true },
          { key: "normative", header: "规范性", render: (r: Json) => (r.normative ? <Badge>是</Badge> : "") },
        ]} />
      </Section>
      <Section title="从历史对话推导" desc="scripts/eval/derive-decay.ts → eval-out/decay-derivation.json">
        {der ? (
          <>
            <Muted>{String(der.span.from).slice(0, 10)} ~ {String(der.span.to).slice(0, 10)} ({der.span.days} 天) · {der.messages.sessions} 个会话 · 规范性断言 {der.assertions} 句 · 候选对 {der.candidatePairs} · 人工标注 {der.labeled.n} 对 (改写 {der.labeled.R} / 重申 {der.labeled.S} / 无关 {der.labeled.U})</Muted>
            <StatGrid columns={3}>
              <StatCard label="改写率 (同话题后续断言里)" value={(der.revisionRate * 100).toFixed(1) + "%"} hint="改写都发生在 0~3 天内: 交给「同话题新压旧」, 当天生效" />
              <StatCard label="改写半衰期" value={der.halfLifeDays + " 天"} hint={`bootstrap 90%: ${der.halfLifeCI90?.[0]} ~ ${der.halfLifeCI90?.[1]} 天`} tone="muted" />
              <StatCard label="仓库停摆半衰期 → rule/decision 的 H" value={der.activity?.halfLifeDays + " 天"} hint={`${der.activity?.messages} 条人发的消息, ${der.activity?.projects} 个项目`} tone="accent" />
            </StatGrid>
            {der.activity ? <DataTable bare rows={der.activity.points.map((p: Json, i: number) => ({ ...p, model: der.activity.model[i].model }))} rowKey={(r: Json) => r.d} columns={[
              { key: "d", header: "d 天后", numeric: true },
              { key: "n", header: "样本", numeric: true },
              { key: "alive", header: "同项目仍有人说话", numeric: true, render: (r: Json) => fmt(r.alive) },
              { key: "model", header: "2^(−d/H)", numeric: true, render: (r: Json) => fmt(r.model) },
            ]} /> : null}
            {der.examples?.length ? <DataTable bare rows={der.examples} rowKey={(_r: Json, i) => i} columns={[
              { key: "at", header: "原断言" },
              { key: "afterDays", header: "几天后被改", numeric: true },
              { key: "old", header: "旧", render: (r: Json) => <Text t={r.old} /> },
              { key: "new", header: "新", render: (r: Json) => <Text t={r.new} /> },
            ]} /> : null}
          </>
        ) : <Muted>还没有推导结果: 在仓库根跑 node --experimental-strip-types scripts/eval/derive-decay.ts</Muted>}
      </Section>
      <Section title="常驻注入: 不看时间 vs 看时间" right={
        <div className="flex gap-2"><Input className="w-48" value={project} onChange={(e) => setProject(e.target.value)} placeholder="项目 (如 HX-Memory)" /><Button size="sm" variant="outline" onClick={reload}>刷新</Button></div>
      } desc="同一份记忆、同一个 400 token 预算, 只差有没有传 now。">
        <div className="flex flex-col gap-4 lg:flex-row">
          {(["before", "after"] as const).map((k) => (
            <Card key={k} variant="muted" className="flex-1">
              <CardHeader><CardTitle>{k === "before" ? "改之前 (按 importance + id)" : "改之后 (× R(age), 被压的不进)"}</CardTitle></CardHeader>
              <CardContent>
                <DataTable bare rows={data.alwaysOn[k]} rowKey={(r: Json) => r.id} emptyText="没有候选" columns={[
                  { key: "kind", header: "类型" },
                  { key: "ageDays", header: "天前", numeric: true },
                  { key: "retention", header: "R", numeric: true, render: (r: Json) => fmt(r.retention) },
                  { key: "text", header: "内容", render: (r: Json) => <Text t={r.text} /> },
                ]} />
              </CardContent>
            </Card>
          ))}
        </div>
        {data.alwaysOn.superseded.length ? <Alert variant="warning"><AlertTitle>被同话题新条目压住、不再注入的 {data.alwaysOn.superseded.length} 条</AlertTitle><AlertDescription>{data.alwaysOn.superseded.map((s: Json) => <div key={s.id}>{s.text} (被 {s.by} 取代)</div>)}</AlertDescription></Alert> : null}
      </Section>
      <DecayScored rows={data.scored ?? []} now={data.now} />
      <Section title="规范性条目的有效置信度" desc={`共 ${data.rows.length} 条 (rule / decision / preference, active), 按有效置信度降序。`}>
        <DataTable rows={data.rows} rowKey={(r: Json) => r.id} maxHeight="32rem" columns={[
          { key: "kind", header: "类型", render: (r: Json) => <Badge variant="outline">{r.kind}</Badge> },
          { key: "ageDays", header: "天前", numeric: true },
          { key: "retention", header: "R", numeric: true, render: (r: Json) => fmt(r.retention) },
          { key: "effective", header: "有效置信度", numeric: true, render: (r: Json) => fmt(r.effective) },
          { key: "reinforcement", header: "被命中", numeric: true },
          { key: "text", header: "内容", render: (r: Json) => <div><Text t={r.text} />{r.supersededBy ? <div className="text-xs text-warning-fg">已被更新: {r.supersededBy.text}</div> : null}</div> },
        ]} />
      </Section>
    </div>
  );
}

// ---------------- 知识库 ----------------
const PURGE_WORD = "清空知识库";

function Kb() {
  const { data, error, reload } = useLoad("kb");
  const [root, setRoot] = useState("");
  const [dirs, setDirs] = useState(".");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");
  const [files, setFiles] = useState<Json>(null);
  const add = () => {
    if (!window.confirm("把 " + root + " 加为知识库并同步一轮? 会往记忆根写 kind:doc 切片 (只在检索时按需返回, 不进每轮注入)。")) return;
    setErr(""); setBusy(root);
    call("kb", { method: "POST", body: { root, dirs } }).then((r: Json) => { setMsg(r.steps.map((s: Json) => s.step + ": " + s.detail).join(" → ")); setRoot(""); reload(); }, (e: Error) => setErr(e.message)).finally(() => setBusy(""));
  };
  const del = (r: string, purge: boolean) => {
    if (purge && !window.confirm("移除来源并把它已入库的切片撤回 (shadow)?")) return;
    call("kb?root=" + encodeURIComponent(r) + (purge ? "&purge=1" : ""), { method: "DELETE" }).then((x: Json) => { setMsg(purge ? `已撤回 ${x.purged} 条切片` : "已移除来源登记"); reload(); }, (e: Error) => setErr(e.message));
  };
  const [arming, setArming] = useState(false);
  const [word, setWord] = useState("");
  const [job, setJob] = useState<Json>(null);
  const poll = useCallback(() => {
    call("kb/purge").then((d: Json) => {
      setJob(d.job);
      if (d.running) setTimeout(poll, 2000);
      else if (d.job) reload();
    }, () => undefined);
  }, [reload]);
  useEffect(() => { poll(); }, [poll]);
  const purging = !!job && job.exit === undefined;
  const slices = (data?.sources ?? []).reduce((a: number, s: Json) => a + (s.slices ?? 0), 0);
  const purge = () => {
    if (word !== PURGE_WORD) return;
    setErr("");
    call("kb/purge", { method: "DELETE", body: { confirm: word } }).then((d: Json) => { setJob(d.job); setArming(false); setWord(""); setTimeout(poll, 1000); }, (e: Error) => setErr(e.message));
  };
  const sync = (r: string) => {
    if (!window.confirm("把 " + r + " 同步进记忆根? 会新增/更新/删除该来源的 kind:doc 条目。")) return;
    setBusy(r); setErr("");
    call("kb/sync", { method: "POST", body: { root: r } }).then((rep: Json) => { setMsg(`${r}: 文件 ${rep.files}, 切片 ${rep.slices}, 新增 ${rep.added}, 更新 ${rep.updated}, 删除 ${rep.removed}, 未变 ${rep.unchanged}, 失败 ${rep.failedCount}, ${rep.ms} ms`); reload(); }, (e: Error) => setErr(e.message)).finally(() => setBusy(""));
  };
  return (
    <div className="flex flex-col gap-4">
      <Section title="新增知识库路径" desc="绝对路径 + 子目录 (逗号分隔, . 表示整个目录)。只扫 .md; 增量路径写自己的命名空间 (kb:@ns/…), 不会动主语料。">
        <div className="flex flex-wrap gap-2">
          <Input className="min-w-[24rem] flex-1" value={root} onChange={(e) => setRoot(e.target.value)} placeholder="/home/hx/notes" />
          <Input className="w-56" value={dirs} onChange={(e) => setDirs(e.target.value)} />
          <Button variant="primary" onClick={add} disabled={!root.trim() || !!busy}>{busy === root && root ? "同步中…" : "添加并同步"}</Button>
        </div>
        <Err msg={err || error} />
        {msg ? <Alert variant="success"><AlertDescription>{msg}</AlertDescription></Alert> : null}
      </Section>
      <Section title="来源" desc={data?.memoryRoot}>
        <DataTable rows={data?.sources ?? []} loading={!data && !error} rowKey={(r: Json) => r.root} emptyText="还没有来源" columns={[
          { key: "root", header: "路径", render: (r: Json) => <div>{r.root}<div className="text-xs text-muted-foreground">{r.namespace} · {r.dirs.join(", ")}{r.missingDirs.length ? ` (缺 ${r.missingDirs.join(", ")})` : ""}</div></div> },
          { key: "state", header: "状态", render: (r: Json) => <Badge variant={r.state === "已同步" ? "success" : r.state === "未入库" ? "outline" : "warning"}>{r.state}</Badge> },
          { key: "files", header: "md / 已入库", numeric: true, render: (r: Json) => `${r.files} / ${r.ingestedFiles}` },
          { key: "slices", header: "切片", numeric: true },
          { key: "lastSync", header: "上次同步", render: (r: Json) => (r.lastSync?.at ? when(r.lastSync.at) : "从未") },
          { key: "op", header: "", render: (r: Json) => (
            <div className="flex flex-wrap gap-1">
              <Button size="sm" variant="outline" onClick={() => call("kb/files?root=" + encodeURIComponent(r.root)).then(setFiles, (e: Error) => setErr(e.message))}>文件</Button>
              <Button size="sm" onClick={() => sync(r.root)} disabled={!!busy || !r.exists}>{busy === r.root ? "同步中…" : "同步"}</Button>
              {r.primary ? null : <><Button size="sm" variant="ghost" onClick={() => del(r.root, false)}>移除</Button><Button size="sm" variant="ghost" onClick={() => del(r.root, true)}>移除并撤回</Button></>}
            </div>
          ) },
        ]} />
      </Section>
      <Section title="清空知识库" desc="删掉记忆根里全部 kb:* doc 切片 (所有来源), 只保留对话沉淀。就是 scripts/kb-purge.ts --apply: 先备份 (一致性快照 + 三件套 + 整棵真相目录), 再 removeMany 真删真相, 最后六条校验 (含「从真相重建一份索引, doc 仍为 0」)。源目录里的 .md 不动, 需要时可重新同步。">
        <Muted>当前切片 {slices} 条</Muted>
        {!arming ? (
          <div><Button variant="destructive" onClick={() => setArming(true)} disabled={purging || !slices}>清空知识库…</Button></div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm">输入「{PURGE_WORD}」确认:</span>
            <Input className="w-48" value={word} onChange={(e) => setWord(e.target.value)} />
            <Button variant="destructive" onClick={purge} disabled={word !== PURGE_WORD}>确认清空</Button>
            <Button variant="ghost" onClick={() => { setArming(false); setWord(""); }}>取消</Button>
          </div>
        )}
        {job ? (
          <div className="flex flex-col gap-1">
            <Muted>{purging ? "清空中…" : job.exit === 0 ? "✓ 完成" : `✗ 退出码 ${job.exit}`} · 开始 {when(job.startedAt)}{job.finishedAt ? ` · 结束 ${when(job.finishedAt)}` : ""} · 备份 {job.backupDir}</Muted>
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-xs">{(job.log ?? []).join("\n")}</pre>
          </div>
        ) : null}
      </Section>
      {files ? (
        <Section title={"文件 · " + files.root} right={<Button size="sm" variant="ghost" onClick={() => setFiles(null)}>关闭</Button>}>
          <DataTable bare rows={files.files} rowKey={(r: Json) => r.file} maxHeight="28rem" columns={[
            { key: "file", header: "文件" },
            { key: "bytes", header: "字节", numeric: true },
            { key: "mtime", header: "修改时间", render: (r: Json) => when(r.mtime) },
            { key: "slices", header: "已入库切片", numeric: true },
          ]} />
        </Section>
      ) : null}
    </div>
  );
}

// ---------------- 检测 ----------------
function Detect() {
  const [text, setText] = useState("");
  const [next, setNext] = useState("");
  const [res, setRes] = useState<Json>(null);
  const [err, setErr] = useState("");
  const run = () => { setErr(""); call("detect", { method: "POST", body: { text, nextAssistant: next || undefined } }).then(setRes, (e: Error) => setErr(e.message)); };
  const Col = ({ title, r }: { title: string; r: Json }) => (
    <Card variant="muted" className="flex-1">
      <CardHeader><CardTitle>{title}</CardTitle><CardDescription>{r.model} · 候选 {String(r.candidate)}</CardDescription></CardHeader>
      <CardContent className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <Badge variant={r.hit ? "destructive" : "secondary"}>{r.hit ? "HIT" : "MISS"}</Badge>
          <span className="tabular-nums">score {fmt(r.score)} / 阈值 {fmt(r.threshold)}</span>
          {r.via ? <Badge variant="outline">{r.via}</Badge> : null}
        </div>
        {r.posterior ? <Muted>轮末后验: {r.posterior.hit ? "HIT" : "MISS"} {fmt(r.posterior.score)}</Muted> : null}
        <DataTable bare rows={r.features} rowKey={(c: Json) => c.feature} emptyText="无特征" columns={[
          { key: "feature", header: "特征" },
          { key: "weight", header: "权重", numeric: true, render: (c: Json) => fmt(c.weight) },
        ]} />
      </CardContent>
    </Card>
  );
  return (
    <div className="flex flex-col gap-4">
      <Section title="实时检测" desc="同一个 detect, 只换 model: 左边当前 model.ts, 右边词表模型 A。填了「助手下一句首句」会再走轮末后验补偿。">
        <Textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="用户这句话, 例如: 不对, 我说的是A不是B" rows={3} />
        <Input value={next} onChange={(e) => setNext(e.target.value)} placeholder="(可选) 助手下一句的首句, 例如: 你说得对" />
        <div><Button variant="primary" onClick={run} disabled={!text.trim()}>检测</Button></div>
        <Err msg={err} />
      </Section>
      {res ? <div className="flex flex-col gap-4 lg:flex-row"><Col title="当前模型" r={res.current} /><Col title="词表模型 A" r={res.lexicon} /></div> : null}
    </div>
  );
}

// ---------------- 评估 ----------------
function Eval() {
  const { data, error } = useLoad("eval");
  if (error) return <Err msg={error} />;
  if (!data) return <Loading />;
  const live: Json[] = data.regression;
  const gated = live.filter((r) => r.expect !== "open");
  const passed = gated.filter((r) => r.pass).length;
  return (
    <div className="flex flex-col gap-4">
      <StatGrid columns={3}>
        <StatCard label="入选模型" value={data.chosen?.id ?? "—"} hint={data.model.version} tone="accent" />
        <StatCard label="回归句 (现场重跑)" value={`${passed}/${gated.length}`} tone={passed === gated.length ? "good" : "bad"} hint={`另有 open ${live.length - gated.length} 条`} />
        <StatCard label="阈值" value={fmt(data.model.threshold)} />
      </StatGrid>
      {data.chosen?.why ? <Muted>{data.chosen.why}</Muted> : null}
      <Section title="候选对比" desc="eval-out/train.json (嵌套分组 CV)">
        <DataTable bare rows={data.candidates} rowKey={(r: Json) => r.id} emptyText="没有 train.json" columns={[
          { key: "id", header: "候选" },
          { key: "name", header: "说明" },
          { key: "recall", header: "召回", numeric: true, render: (r: Json) => fmt(r.recall) },
          { key: "fpr", header: "误报率", numeric: true, render: (r: Json) => fmt(r.fpr) },
          { key: "cm", header: "TP/FP/FN/TN", render: (r: Json) => `${r.tp}/${r.fp}/${r.fn}/${r.tn}` },
        ]} />
      </Section>
      <Section title="回归句" desc="tests/fixtures/eval/frustration/regression.jsonl, 打开页面时现场重跑">
        <DataTable bare rows={live} rowKey={(r: Json) => r.id} maxHeight="32rem" columns={[
          { key: "expect", header: "期望" },
          { key: "text", header: "句子", render: (r: Json) => <Text t={r.next ? `${r.text} → 「${r.next}」` : r.text} /> },
          { key: "cur", header: "当前", render: (r: Json) => <Badge variant={r.currentHit ? "destructive" : "secondary"}>{r.currentHit ? "HIT" : "MISS"} {fmt(r.score)}</Badge> },
          { key: "lex", header: "A", render: (r: Json) => (r.lexiconHit ? "HIT" : "MISS") },
          { key: "pass", header: "结果", render: (r: Json) => <Badge variant={r.pass ? "success" : "destructive"}>{r.pass ? "通过" : "失败"}</Badge> },
        ]} />
      </Section>
    </div>
  );
}

// ---------------- 语义检索状态 (FIX-ROUND-2) ----------------
function SemanticNotice() {
  const { data } = useLoad("embedding");
  const r = data?.retrieval;
  if (!r) return null;
  if (!r.semantic) {
    return (
      <Alert variant={"warning" as never}>
        <AlertTitle>当前只有 BM25, 语义检索未启用</AlertTitle>
        <AlertDescription>{r.panel}。同义改写可能搜不到。在「模型 → 嵌入模型」配置后生效。</AlertDescription>
      </Alert>
    );
  }
  return (
    <Alert variant={"success" as never}>
      <AlertTitle>语义检索已启用: {r.model}</AlertTitle>
      <AlertDescription>{r.panel}{r.progress ? ` · 向量投影 ${r.progress.embedded}/${r.progress.total}` : ""}{r.keyError ? ` · key 问题: ${r.keyError}` : ""}</AlertDescription>
    </Alert>
  );
}

function EmbeddingCfg() {
  const { data, error, reload } = useLoad("embedding");
  const [f, setF] = useState({ base_url: "", model: "", dim: "", key_mode: "none", key_env: "", api_key: "" });
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [test, setTest] = useState<Json>(null);
  useEffect(() => {
    if (data) setF((x) => ({ ...x, base_url: data.base_url, model: data.model, dim: data.dim ? String(data.dim) : "", key_mode: data.key_mode, key_env: data.key_env }));
  }, [data]);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const save = () => {
    setErr(""); setMsg("");
    const body: Json = { base_url: f.base_url, model: f.model, dim: f.dim, key_mode: f.key_mode };
    if (f.key_mode === "env") body.key_env = f.key_env;
    else if (f.key_mode === "encrypted" && f.api_key.trim()) body.api_key = f.api_key;
    call("embedding", { method: "PUT", body }).then(() => { setF({ ...f, api_key: "" }); setMsg("已保存; 记忆栈已按新嵌入器重开"); reload(); }, (e: Error) => setErr(e.message));
  };
  const runTest = () => { setErr(""); setTest(null); call("embedding/test", { method: "POST" }).then(setTest, (e: Error) => setErr(e.message)); };
  const r = data?.retrieval;
  return (
    <Section title="嵌入模型 (语义检索)" desc="与上面的判官模型分开配置: 走 POST {base_url}/embeddings。环境变量 HX_MEMORY_EMBEDDING_* 优先于这里。">
      <Err msg={err || error} />
      {r && !r.semantic ? <Alert variant={"warning" as never}><AlertTitle>当前只有 BM25, 语义检索未启用</AlertTitle><AlertDescription>嵌入模型未配置。</AlertDescription></Alert> : null}
      {r && r.semantic ? <Muted>生效中: {r.panel}</Muted> : null}
      <label className="flex flex-col gap-1 text-sm">base_url<Input value={f.base_url} onChange={set("base_url")} placeholder="http://127.0.0.1:4399/v1" /></label>
      <div className="flex gap-2">
        <label className="flex flex-1 flex-col gap-1 text-sm">model<Input value={f.model} onChange={set("model")} placeholder="Qwen3-Embedding-0.6B" /></label>
        <label className="flex w-32 flex-col gap-1 text-sm">维度 (可空)<Input value={f.dim} onChange={set("dim")} /></label>
      </div>
      <div className="flex items-center gap-4 text-sm">
        <label className="flex items-center gap-1"><input type="radio" checked={f.key_mode === "none"} onChange={() => setF({ ...f, key_mode: "none" })} />无需 key</label>
        <label className="flex items-center gap-1"><input type="radio" checked={f.key_mode === "encrypted"} onChange={() => setF({ ...f, key_mode: "encrypted" })} />key 加密保存</label>
        <label className="flex items-center gap-1"><input type="radio" checked={f.key_mode === "env"} onChange={() => setF({ ...f, key_mode: "env" })} />只记环境变量名</label>
      </div>
      {f.key_mode === "env" ? <label className="flex flex-col gap-1 text-sm">环境变量名<Input value={f.key_env} onChange={set("key_env")} /></label> : null}
      {f.key_mode === "encrypted" ? (
        <label className="flex flex-col gap-1 text-sm">API key {data?.has_key ? <span className="text-muted-foreground">(已保存: {data.api_key_masked}; 留空不改)</span> : null}
          <Input type="password" value={f.api_key} onChange={set("api_key")} autoComplete="off" />
        </label>
      ) : null}
      <div className="flex gap-2">
        <Button variant="primary" onClick={save}>保存</Button>
        <Button variant="outline" onClick={runTest}>测试一次 /embeddings</Button>
      </div>
      {msg ? <Muted>{msg}</Muted> : null}
      {test ? (
        <div className="flex flex-col gap-1">
          <div className="flex gap-2"><Badge variant={test.error ? "destructive" : "success"}>{test.status ?? "无响应"}</Badge><span>{test.ms} ms · 维度 {test.dim ?? "—"} · 来源 {test.source}</span></div>
          {test.error ? <Err msg={test.error} /> : null}
        </div>
      ) : null}
    </Section>
  );
}

// ---------------- 模型配置 ----------------
function ModelCfg() {
  const { data, error, reload } = useLoad("model");
  const [f, setF] = useState({ base_url: "", model: "", temperature: "0.2", key_mode: "encrypted", key_env: "", api_key: "" });
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [test, setTest] = useState<Json>(null);
  useEffect(() => {
    if (data) setF((x) => ({ ...x, base_url: data.base_url, model: data.model, temperature: String(data.temperature), key_mode: data.key_mode === "env" ? "env" : "encrypted", key_env: data.key_env }));
  }, [data]);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const save = () => {
    setErr(""); setMsg("");
    const body: Json = { base_url: f.base_url, model: f.model, temperature: f.temperature, key_mode: f.key_mode };
    if (f.key_mode === "env") body.key_env = f.key_env;
    else if (f.api_key.trim()) body.api_key = f.api_key;
    call("model", { method: "PUT", body }).then(() => { setF({ ...f, api_key: "" }); setMsg("已保存"); reload(); }, (e: Error) => setErr(e.message));
  };
  const runTest = () => { setErr(""); setTest(null); call("model/test", { method: "POST" }).then(setTest, (e: Error) => setErr(e.message)); };
  return (
    <div className="flex flex-col gap-4">
      {data && !data.judgeConfigured ? (
        <Alert variant={"danger" as never}>
          <AlertTitle>判官未配置, 同轮评审不可用</AlertTitle>
          <AlertDescription>缺 {(data.judgeMissing ?? []).join(" / ")}。挫折命中后的 LLM 评审 (结论入库 / 同轮注入) 不会运行; 检测本身是本地线性打分, 不受影响。</AlertDescription>
        </Alert>
      ) : data ? (
        <Alert variant={"success" as never}><AlertTitle>判官已配置 ({data.model})</AlertTitle><AlertDescription>用下面的「测试」确认真能连通; 已配置不等于可用。</AlertDescription></Alert>
      ) : null}
      <Section title="OpenAI 兼容接口" desc={data ? `${data.storage} · ${data.configFile}` : undefined}>
        <Err msg={err || error} />
        <label className="flex flex-col gap-1 text-sm">base_url<Input value={f.base_url} onChange={set("base_url")} placeholder="https://api.openai.com/v1" /></label>
        <div className="flex gap-2">
          <label className="flex flex-1 flex-col gap-1 text-sm">model<Input value={f.model} onChange={set("model")} placeholder="gpt-4o-mini" /></label>
          <label className="flex w-32 flex-col gap-1 text-sm">temperature<Input value={f.temperature} onChange={set("temperature")} /></label>
        </div>
        <div className="flex items-center gap-4 text-sm">
          <label className="flex items-center gap-1"><input type="radio" checked={f.key_mode === "encrypted"} onChange={() => setF({ ...f, key_mode: "encrypted" })} />key 加密保存</label>
          <label className="flex items-center gap-1"><input type="radio" checked={f.key_mode === "env"} onChange={() => setF({ ...f, key_mode: "env" })} />只记环境变量名</label>
        </div>
        {f.key_mode === "env" ? (
          <label className="flex flex-col gap-1 text-sm">环境变量名<Input value={f.key_env} onChange={set("key_env")} placeholder="OPENAI_API_KEY" /></label>
        ) : (
          <label className="flex flex-col gap-1 text-sm">API key {data?.has_key ? <span className="text-muted-foreground">(已保存: {data.api_key_masked}{data.key_error ? ", 解密失败: " + data.key_error : ""}; 留空不改)</span> : null}
            <Input type="password" value={f.api_key} onChange={set("api_key")} placeholder="sk-…" autoComplete="off" />
          </label>
        )}
        <div className="flex gap-2">
          <Button variant="primary" onClick={save}>保存</Button>
          <Button variant="outline" onClick={runTest}>测试一次 /chat/completions</Button>
        </div>
        {msg ? <Muted>{msg}</Muted> : null}
      </Section>
      {test ? (
        <Section title="测试结果" desc={test.url}>
          <div className="flex gap-2"><Badge variant={test.error ? "destructive" : "success"}>{test.status ?? "无响应"}</Badge><span>{test.ms} ms · key {test.keyUsed}</span></div>
          {test.reply !== null ? <Muted>回复: {test.reply}</Muted> : null}
          {test.error ? <Err msg={test.error} /> : null}
          {test.raw ? <pre className="max-h-64 overflow-auto rounded bg-muted/40 p-2 text-xs">{test.raw}</pre> : null}
        </Section>
      ) : null}
      <EmbeddingCfg />
    </div>
  );
}

const TABS = [
  { id: "overview", label: "总览" },
  { id: "hooks", label: "Hook" },
  { id: "memory", label: "记忆" },
  { id: "decay", label: "时间衰减" },
  { id: "kb", label: "知识库" },
  { id: "detect", label: "检测" },
  { id: "eval", label: "评估" },
  { id: "model", label: "模型" },
];

export function App() {
  const [tab, setTab] = useState(() => location.hash.slice(1) || "overview");
  useEffect(() => { location.hash = tab; }, [tab]);
  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-4 p-6">
      <PageHeader title="HX-Memory 面板" desc="记忆、时间衰减、知识库、挫折检测与评估; 读的都是本机真实数据。" />
      <NavTabs items={TABS} value={tab} onChange={setTab} />
      {tab === "overview" ? <Overview /> : null}
      {tab === "hooks" ? <Hooks /> : null}
      {tab === "memory" ? <Memory /> : null}
      {tab === "decay" ? <Decay /> : null}
      {tab === "kb" ? <Kb /> : null}
      {tab === "detect" ? <Detect /> : null}
      {tab === "eval" ? <Eval /> : null}
      {tab === "model" ? <ModelCfg /> : null}
    </div>
  );
}
