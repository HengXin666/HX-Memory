// src/adapters/dsh/client/review-page.tsx — 推广审阅页 (React)。
// 所有宿主调用走 ./rpc.js (通道/endpoint/payload/解包只在那里定义一次)。
//
// 三个页签: 推广提议 / 新沉淀 / 调用记录。
// "推广提议"页顶部是批次状态栏 —— 它回答用户"为什么效果不好":
//   轮询 generalizationStatus, 显示上次批次真实数字 (考虑/聚类/提议/耗时/是否 LLM),
//   以及队列计数; abstractor 未挂载时明确警告"只能产出草稿规则, 需人工重写"。
import { useCallback, useEffect, useState } from "react";
import type { Locale } from "./locale.js";
import { callHxMemory, type HxMemoryRpcCaller } from "./rpc.js";

/** 面板对外暴露的 RPC 面 (供 index.tsx 类型收敛)。 */
export type ReviewRpc = HxMemoryRpcCaller;

type T = (key: keyof Locale, vars?: Record<string, unknown>) => string;

interface Props {
  rpc: HxMemoryRpcCaller;
  t: T;
}

interface ReviewView {
  id: string;
  status: "proposed" | "confirmed" | "rejected";
  rule: string;
  covers: number;
  confidence: number;
  sourceRun: string;
  generatedAt: string;
}

interface RecentView {
  id: string;
  kind: string;
  content: string;
  project?: string;
  scope: string;
  assertedAt: string;
  tags?: string[];
}

/** 被 agent 负面标注过的记忆 (bad/exposure/quality 三件都要可见, 降权才可解释)。 */
interface FlaggedView {
  id: string;
  kind: string;
  content: string;
  irrelevant: number;
  wrong: number;
  exposure: number;
  quality: number;
}

interface InvocationView {
  task: string;
  prompt: string;
  input: string;
  output: string;
  ok: boolean;
  ms: number;
  at: string;
}

interface HitView {
  kind?: string;
  content?: string;
  scope?: string;
  project?: string;
  [k: string]: unknown;
}

/** 一次推广批次的运行报告 (runGeneralization 的返回值, 与 lastRun 同形)。 */
interface BatchReport {
  ok?: boolean;
  error?: string;
  at?: string;
  considered?: number;
  coveredSkipped?: number;
  clusters?: number;
  proposed?: number;
  usedLlm?: boolean;
  tookMs?: number;
}

/** generalizationStatus 的返回形状。 */
interface GenStatus {
  abstractor: boolean;
  lastRun?: BatchReport;
  queue: { proposed: number; confirmed: number; rejected: number };
}

const KIND_KEYS = ["fact", "preference", "decision", "lesson", "rule", "pattern"] as const;
const SCOPE_KEYS = ["project", "global", "agent"] as const;

/** 把后端 kind 映射到调色板类名 (未知值退回中性徽章)。 */
function kindClass(kind: string | undefined): string {
  if (kind && (KIND_KEYS as readonly string[]).includes(kind)) return "k-" + kind;
  return "";
}

/** 把 scope 映射到调色板类名 (未知值退回中性徽章)。 */
function scopeClass(scope: string | undefined): string {
  if (scope && (SCOPE_KEYS as readonly string[]).includes(scope)) return "s-" + scope;
  return "";
}

/** 后端时间戳 → 本地可读文本; 解析不了就原样截断, 不抛错。 */
function stamp(at: string | undefined): string {
  if (!at) return "";
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return at.slice(0, 19).replace("T", " ");
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    String(d.getFullYear()) +
    "-" +
    pad(d.getMonth() + 1) +
    "-" +
    pad(d.getDate()) +
    " " +
    pad(d.getHours()) +
    ":" +
    pad(d.getMinutes())
  );
}

/** 状态栏里的一格数字。 */
function Stat({ value, label }: { value: string; label: string }): JSX.Element {
  return (
    <span className="stat">
      <b>{value}</b>
      <span className="stat-label">{label}</span>
    </span>
  );
}

export function ReviewPage({ rpc, t }: Props): JSX.Element {
  const [queue, setQueue] = useState<ReviewView[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState("");
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<HitView[]>([]);
  const [searched, setSearched] = useState(false);
  const [tab, setTab] = useState<"props" | "recent" | "inv" | "flagged">("props");
  const [inv, setInv] = useState<InvocationView[]>([]);
  const [flagged, setFlagged] = useState<FlaggedView[]>([]);
  const [recent, setRecent] = useState<RecentView[]>([]);
  const [recentMsg, setRecentMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [busySince, setBusySince] = useState(0);
  const [now, setNow] = useState(0);
  const [report, setReport] = useState<BatchReport | null>(null);
  const [status, setStatus] = useState<GenStatus | null>(null);
  const [statusErr, setStatusErr] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const list = await callHxMemory<ReviewView[]>(rpc, "reviewQueue", { status: "proposed" });
      setQueue(list ?? []);
    } catch (e) {
      setMsg(String(e));
      setQueue([]);
    } finally {
      setLoading(false);
    }
  }, [rpc]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * 面板打开期间也要跟着变: 记忆捕获、推广批次、别处确认都可能改变后端状态。
   * 只挂载时拉一次会让显示长期陈旧 —— 用户唯一的办法是重启宿主 (真实反馈)。
   * 三重刷新: 窗口重新获得焦点 / 面板重新可见 / 定时轮询 (切到后台时停, 不浪费请求)。
   */
  useEffect(() => {
    const onFocus = () => void refresh();
    const onVisibility = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    let timer: ReturnType<typeof setInterval> | undefined;
    if (document.visibilityState === "visible") timer = setInterval(onFocus, 5000);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
      if (timer !== undefined) clearInterval(timer);
    };
  }, [refresh]);

  /**
   * 批次状态栏: 同一套 focus/visibility/5s 轮询, 只在"推广提议"页签且面板可见时生效。
   * 失败写进 statusErr 而不是抛出去 —— 老 gateway 没有这个方法时页面照常可用。
   */
  const refreshStatus = useCallback(async () => {
    try {
      const s = await callHxMemory<GenStatus>(rpc, "generalizationStatus");
      setStatus(s ?? null);
      setStatusErr("");
    } catch (e) {
      setStatusErr(String(e));
    }
  }, [rpc]);

  useEffect(() => {
    if (tab !== "props") return;
    const onShow = () => {
      if (document.visibilityState === "visible") void refreshStatus();
    };
    window.addEventListener("focus", onShow);
    document.addEventListener("visibilitychange", onShow);
    void refreshStatus();
    let timer: ReturnType<typeof setInterval> | undefined;
    if (document.visibilityState === "visible") timer = setInterval(onShow, 5000);
    return () => {
      window.removeEventListener("focus", onShow);
      document.removeEventListener("visibilitychange", onShow);
      if (timer !== undefined) clearInterval(timer);
    };
  }, [tab, refreshStatus]);

  /** 批次运行期间每秒推进一次"运行中… Ns"。 */
  useEffect(() => {
    if (!busy) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [busy]);

  const act = async (
    id: string,
    method: "confirmProposal" | "rejectProposal",
    extra: Record<string, unknown> = {},
  ) => {
    setMsg("");
    try {
      const res = await callHxMemory<{ ok?: boolean; error?: string }>(rpc, method, {
        id,
        ...extra,
      });
      if (res.ok === false) setMsg(res.error ?? "failed");
      else setMsg(method === "confirmProposal" ? t("confirmed") : t("rejected"));
      await refresh();
      await refreshStatus();
    } catch (e) {
      setMsg(String(e));
    }
  };

  /** 手动触发一次推广批次 (从最近的 lesson/pattern/decision 聚类 → 提议进队列)。 */
  const runBatch = async () => {
    setBusy(true);
    setBusySince(Date.now());
    setMsg("");
    setReport(null);
    try {
      const res = await callHxMemory<BatchReport>(rpc, "runGeneralization", { limit: 100 });
      setReport(res ?? { ok: false, error: "empty report" });
      if (res?.ok === false) setMsg(t("reportFailed", { error: res.error ?? "failed" }));
      await refresh();
      await refreshStatus();
    } catch (e) {
      setMsg(String(e));
      setReport({ ok: false, error: String(e) });
    } finally {
      setBusy(false);
    }
  };

  const search = async () => {
    const q = query.trim();
    setSearched(true);
    try {
      const res = await callHxMemory<HitView[]>(rpc, "memoryQuery", {
        q: { text: q || undefined, limit: 20 },
      });
      setHits(res ?? []);
    } catch (e) {
      setMsg(String(e));
      setHits([]);
    }
  };

  const refreshInv = useCallback(async () => {
    try {
      const list = await callHxMemory<InvocationView[]>(rpc, "listInvocations", { limit: 50 });
      setInv(list ?? []);
    } catch {
      setInv([]);
    }
  }, [rpc]);

  useEffect(() => {
    if (tab === "inv") void refreshInv();
  }, [tab, refreshInv]);

  const refreshRecent = useCallback(async () => {
    try {
      const list = await callHxMemory<RecentView[]>(rpc, "recentCaptures", { limit: 30 });
      setRecent(list ?? []);
    } catch {
      setRecent([]);
    }
  }, [rpc]);

  useEffect(() => {
    if (tab === "recent") void refreshRecent();
  }, [tab, refreshRecent]);

  const refreshFlagged = useCallback(async () => {
    try {
      const list = await callHxMemory<FlaggedView[]>(rpc, "flaggedMemories", { limit: 50 });
      setFlagged(list ?? []);
    } catch {
      setFlagged([]);
    }
  }, [rpc]);

  useEffect(() => {
    if (tab === "flagged") void refreshFlagged();
  }, [tab, refreshFlagged]);

  const delRecent = async (id: string) => {
    setRecentMsg("");
    try {
      const res = await callHxMemory<{ ok?: boolean; error?: string }>(rpc, "deleteEntry", { id });
      if (res.ok === false) setRecentMsg(res.error ?? "failed");
      else setRecentMsg(t("deleted"));
      await refreshRecent();
    } catch (e) {
      setRecentMsg(String(e));
    }
  };

  const lastRun = status?.lastRun;
  const elapsed = busy && busySince > 0 ? Math.max(0, Math.round((now - busySince) / 1000)) : 0;
  const runLabel = busy ? t("runningLive", { n: String(elapsed) }) : t("runBatch");

  return (
    <div className="hxmem-review">
      <div className="tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "props"}
          className={tab === "props" ? "tab on" : "tab"}
          onClick={() => setTab("props")}
        >
          {t("tabProposals")}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "recent"}
          className={tab === "recent" ? "tab on" : "tab"}
          onClick={() => setTab("recent")}
        >
          {t("tabRecent")}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "inv"}
          className={tab === "inv" ? "tab on" : "tab"}
          onClick={() => setTab("inv")}
        >
          {t("tabInvocations")}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "flagged"}
          className={tab === "flagged" ? "tab on" : "tab"}
          onClick={() => setTab("flagged")}
        >
          {t("tabFlagged")}
        </button>
      </div>

      {tab === "flagged" ? (
        <section className="pane">
          <h3>{t("flaggedTitle")}</h3>
          {flagged.length === 0 ? (
            <div className="empty">{t("flaggedEmpty")}</div>
          ) : (
            <div className="list">
              {flagged.map((v) => (
                <div className="row" key={v.id}>
                  <span className="badge rejected">{t("flaggedBad")} {v.irrelevant + v.wrong}</span>
                  <span className="content">{v.content}</span>
                  <span className="meta">
                    [{v.kind}] {v.id} · {t("flaggedExposure")} {v.exposure} ·{" "}
                    {t("flaggedQuality")} {v.quality.toFixed(2)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>
      ) : null}

      {tab === "inv" ? (
        <section className="pane">
          <h3>{t("tabInvocations")}</h3>
          {inv.length === 0 ? (
            <div className="empty">{t("invEmpty")}</div>
          ) : (
            <div className="list">
              {inv.map((v, i) => (
                <details className="inv" key={i}>
                  <summary>
                    <span className={"badge " + (v.ok ? "confirmed" : "rejected")}>
                      {v.ok ? t("invOk") : t("invFail")}
                    </span>
                    <span className="inv-task">{v.task}</span>
                    <span className="meta">
                      {v.ms} ms · {stamp(v.at)}
                    </span>
                  </summary>
                  <div className="inv-body">
                    <div className="inv-field">
                      <b>{t("invPrompt")}</b>
                      <pre>{v.prompt}</pre>
                    </div>
                    <div className="inv-field">
                      <b>{t("invInput")}</b>
                      <pre>{v.input}</pre>
                    </div>
                    <div className="inv-field">
                      <b>{t("invOutput")}</b>
                      <pre>{v.output}</pre>
                    </div>
                  </div>
                </details>
              ))}
            </div>
          )}
        </section>
      ) : tab === "recent" ? (
        <section className="pane">
          <h3>{t("recentTitle")}</h3>
          {recentMsg ? <div className="banner info">{recentMsg}</div> : null}
          {recent.length === 0 ? (
            <div className="empty">{t("recentEmpty")}</div>
          ) : (
            <div className="list">
              {recent.map((r) => (
                <div className="row" key={r.id}>
                  <span className={"badge " + kindClass(r.kind)}>{r.kind}</span>
                  <span className={"badge soft " + scopeClass(r.scope)}>{r.project ?? r.scope}</span>
                  <span className="rule-text">{r.content}</span>
                  <span className="meta">
                    {stamp(r.assertedAt)}
                    {r.tags?.length ? " · #" + r.tags.join(" #") : ""}
                  </span>
                  <button
                    type="button"
                    className="danger"
                    onClick={() => void delRecent(r.id)}
                    title={t("recentDelete")}
                  >
                    {t("recentDelete")}
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>
      ) : (
        <section className="pane">
          <div className="status">
            <div className="status-head">
              <span className="status-title">{t("statusTitle")}</span>
              {status ? (
                <span className={"badge " + (status.abstractor ? "confirmed" : "rejected")}>
                  {status.abstractor ? t("abstractorOn") : t("abstractorOff")}
                </span>
              ) : null}
              {status ? (
                <>
                  <span className="badge proposed">
                    {status.queue.proposed} {t("queueProposed")}
                  </span>
                  <span className="badge soft">
                    {status.queue.confirmed} {t("queueConfirmed")}
                  </span>
                  <span className="badge soft">
                    {status.queue.rejected} {t("queueRejected")}
                  </span>
                </>
              ) : null}
              <button type="button" className="ghost" onClick={() => void refreshStatus()}>
                {t("statusRefresh")}
              </button>
            </div>

            {lastRun ? (
              <>
                <div className="meta">{t("statusAt", { at: stamp(lastRun.at) })}</div>
                <div className="stats">
                  <Stat value={String(lastRun.considered ?? 0)} label={t("statusConsidered")} />
                  <Stat value={String(lastRun.clusters ?? 0)} label={t("statusClusters")} />
                  <Stat value={String(lastRun.proposed ?? 0)} label={t("statusProposed")} />
                  <Stat value={String(lastRun.coveredSkipped ?? 0)} label={t("statusSkipped")} />
                  <Stat value={String(lastRun.tookMs ?? 0)} label={t("statusMs")} />
                  <span className={"badge " + (lastRun.usedLlm ? "confirmed" : "soft")}>
                    {lastRun.usedLlm ? t("statusUsedLlm") : t("statusRuleOnly")}
                  </span>
                </div>
              </>
            ) : (
              <div className="meta">{status ? t("statusNever") : t("loading")}</div>
            )}

            {status && status.abstractor === false ? (
              <div className="banner warn">{t("abstractorOffWarn")}</div>
            ) : null}
            {lastRun?.error ? (
              <div className="banner err">{t("statusError", { error: lastRun.error })}</div>
            ) : null}
            {statusErr ? (
              <div className="banner err">{t("statusUnavailable", { error: statusErr })}</div>
            ) : null}
          </div>

          <div className="actions">
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() => void runBatch()}
            >
              {runLabel}
            </button>
            {busy ? <span className="pulse" /> : null}
            {msg ? <span className="meta">{msg}</span> : null}
          </div>

          {report ? (
            <div className={"report" + (report.ok === false ? " bad" : "")}>
              <div className="report-head">
                <b>{t("reportTitle")}</b>
                <span className={"badge " + (report.ok === false ? "rejected" : "confirmed")}>
                  {report.at ? stamp(report.at) : "—"}
                </span>
              </div>
              <div className="stats">
                <Stat value={String(report.considered ?? 0)} label={t("statusConsidered")} />
                <Stat value={String(report.clusters ?? 0)} label={t("statusClusters")} />
                <Stat value={String(report.proposed ?? 0)} label={t("statusProposed")} />
                <Stat value={String(report.tookMs ?? 0)} label={t("statusMs")} />
                <span className={"badge " + (report.usedLlm ? "confirmed" : "soft")}>
                  {report.usedLlm ? t("statusUsedLlm") : t("statusRuleOnly")}
                </span>
              </div>
              {report.error ? (
                <div className="banner err">{t("reportFailed", { error: report.error })}</div>
              ) : null}
            </div>
          ) : null}

          <h3 className="section-title">
            {t("queue")}
            <span className="count">{t("proposalsCount", { n: String(queue.length) })}</span>
          </h3>
          {loading ? (
            <div className="empty">{t("loading")}</div>
          ) : queue.length === 0 ? (
            <div className="empty">{t("empty")}</div>
          ) : (
            <div className="list">
              {queue.map((p) => (
                <div className="row" key={p.id}>
                  <span className={"badge " + p.status}>{p.status}</span>
                  <span className="rule-text">{p.rule}</span>
                  <span className="meta">
                    {t("covers", { n: String(p.covers) })} · {Math.round(p.confidence * 100)}%
                  </span>
                  <span className="row-actions">
                    <button
                      type="button"
                      className="confirm"
                      onClick={() => void act(p.id, "confirmProposal", { by: "user:dsh-web" })}
                    >
                      {t("confirm")}
                    </button>
                    <button
                      type="button"
                      className="reject"
                      onClick={() => void act(p.id, "rejectProposal")}
                    >
                      {t("reject")}
                    </button>
                  </span>
                </div>
              ))}
            </div>
          )}

          <h3 className="section-title">{t("browse")}</h3>
          <p className="hint">{t("browseHint")}</p>
          <div className="search">
            <input
              value={query}
              onChange={(e) => setQuery((e.target as HTMLInputElement).value)}
              onKeyDown={(e: React.KeyboardEvent) => e.key === "Enter" && void search()}
              placeholder={t("search")}
            />
            <button type="button" onClick={() => void search()}>
              {t("searchBtn")}
            </button>
          </div>
          {searched && hits.length === 0 ? <div className="empty">{t("browseEmpty")}</div> : null}
          {hits.length > 0 ? (
            <div className="list">
              {hits.map((h, i) => (
                <div className="row" key={String((h as { id?: string }).id ?? i)}>
                  <span className="badge rank">{t("rank", { n: String(i + 1) })}</span>
                  <span className={"badge " + kindClass(h.kind)}>{h.kind ?? "?"}</span>
                  <span className={"badge soft " + scopeClass(h.scope)}>
                    {h.project ?? h.scope ?? "—"}
                  </span>
                  <span className="rule-text">{h.content}</span>
                </div>
              ))}
            </div>
          ) : null}
        </section>
      )}
    </div>
  );
}
