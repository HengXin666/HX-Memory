// src/adapters/dsh/client/review-page.tsx — 推广审阅页 (React)。
// 所有宿主调用走 ./rpc.js (通道/endpoint/payload/解包只在那里定义一次)。
import { useCallback, useEffect, useState } from "react";
import type { Locale } from "./locale.js";
import { callHxMemory, type HxMemoryRpcCaller } from "./rpc.js";

/** 面板对外暴露的 RPC 面 (供 index.tsx 类型收敛)。 */
export type ReviewRpc = HxMemoryRpcCaller;

interface ReviewView {
  id: string;
  status: "proposed" | "confirmed" | "rejected";
  rule: string;
  covers: number;
  confidence: number;
  sourceRun: string;
  generatedAt: string;
}

interface Props {
  rpc: HxMemoryRpcCaller;
  t: (key: keyof Locale, vars?: Record<string, unknown>) => string;
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

interface InvocationView {
  task: string;
  prompt: string;
  input: string;
  output: string;
  ok: boolean;
  ms: number;
  at: string;
}

export function ReviewPage({ rpc, t }: Props): JSX.Element {
  const [queue, setQueue] = useState<ReviewView[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState("");
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<unknown[]>([]);
  const [tab, setTab] = useState<"props" | "recent" | "inv">("props");
  const [inv, setInv] = useState<InvocationView[]>([]);
  const [recent, setRecent] = useState<RecentView[]>([]);
  const [recentMsg, setRecentMsg] = useState("");
  const [busy, setBusy] = useState(false);

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
    } catch (e) {
      setMsg(String(e));
    }
  };

  /** 手动触发一次推广批次 (从最近的 lesson/pattern/decision 聚类 → 提议进队列)。 */
  const runBatch = async () => {
    setBusy(true);
    setMsg("");
    try {
      const res = await callHxMemory<{ ok: boolean; proposed: number; error?: string }>(
        rpc,
        "runGeneralization",
        { limit: 100 },
      );
      setMsg(
        res.ok === false ? (res.error ?? "failed") : t("batchDone", { n: String(res.proposed) }),
      );
      await refresh();
    } catch (e) {
      setMsg(String(e));
    } finally {
      setBusy(false);
    }
  };

  const search = async () => {
    const q = query.trim();
    try {
      const res = await callHxMemory<Record<string, unknown>[]>(rpc, "memoryQuery", {
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

  return (
    <div className="hxmem-review">
      <div className="tabs" style={{ display: "flex", gap: 8, marginBottom: 8 }}>
        <button style={tab === "props" ? { fontWeight: 700 } : {}} onClick={() => setTab("props")}>
          {t("tabProposals")}
        </button>
        <button
          style={tab === "recent" ? { fontWeight: 700 } : {}}
          onClick={() => setTab("recent")}
        >
          {t("tabRecent")}
        </button>
        <button style={tab === "inv" ? { fontWeight: 700 } : {}} onClick={() => setTab("inv")}>
          {t("tabInvocations")}
        </button>
      </div>
      {tab === "inv" ? (
        <div className="hxmem-inv">
          <h3>{t("tabInvocations")}</h3>
          {inv.length === 0 ? (
            <div className="empty">{t("invEmpty")}</div>
          ) : (
            inv.map((v, i) => (
              <details key={i} style={{ marginBottom: 6, border: "1px solid #ccc", padding: 4 }}>
                <summary>
                  <span className={"badge " + (v.ok ? "confirmed" : "rejected")}>
                    {v.ok ? t("invOk") : t("invFail")}
                  </span>{" "}
                  {v.task} · {v.ms}ms · {v.at.slice(0, 19)}
                </summary>
                <div style={{ fontSize: 12, whiteSpace: "pre-wrap" }}>
                  <div>
                    <b>{t("invPrompt")}:</b> {v.prompt}
                  </div>
                  <div>
                    <b>{t("invInput")}:</b> {v.input}
                  </div>
                  <div>
                    <b>{t("invOutput")}:</b> {v.output}
                  </div>
                </div>
              </details>
            ))
          )}
        </div>
      ) : tab === "recent" ? (
        <div className="hxmem-recent">
          <h3>{t("recentTitle")}</h3>
          {recentMsg ? <div className="meta">{recentMsg}</div> : null}
          {recent.length === 0 ? (
            <div className="empty">{t("recentEmpty")}</div>
          ) : (
            recent.map((r) => (
              <div className="row" key={r.id}>
                <span className="badge">{r.kind}</span>
                <span className="rule-text">{r.content}</span>
                <span className="meta">
                  {r.project ?? r.scope} · {r.assertedAt.slice(0, 10)}
                  {r.tags?.length ? " · #" + r.tags.join(" #") : ""}
                </span>
                <button className="confirm" onClick={() => void delRecent(r.id)}>
                  {t("recentDelete")}
                </button>
              </div>
            ))
          )}
        </div>
      ) : (
        <>
          <h3>{t("queue")}</h3>
          {msg ? <div className="meta">{msg}</div> : null}
          <div style={{ margin: "8px 0" }}>
            <button className="confirm" disabled={busy} onClick={() => void runBatch()}>
              {busy ? t("running") : t("runBatch")}
            </button>
          </div>
          {loading ? (
            <div className="empty">…</div>
          ) : queue.length === 0 ? (
            <div className="empty">{t("empty")}</div>
          ) : (
            queue.map((p) => (
              <div className="row" key={p.id}>
                <span className={"badge " + p.status}>{p.status}</span>
                <span className="rule-text">{p.rule}</span>
                <span className="meta">
                  {t("covers", { n: String(p.covers) })} · {Math.round(p.confidence * 100)}%
                </span>
                <button
                  className="confirm"
                  onClick={() => void act(p.id, "confirmProposal", { by: "user:dsh-web" })}
                >
                  {t("confirm")}
                </button>
                <button className="reject" onClick={() => void act(p.id, "rejectProposal")}>
                  {t("reject")}
                </button>
              </div>
            ))
          )}

          <h3 style={{ marginTop: 16 }}>{t("browse")}</h3>
          <div className="row">
            <input
              value={query}
              onChange={(e) => setQuery((e.target as HTMLInputElement).value)}
              onKeyDown={(e: React.KeyboardEvent) => e.key === "Enter" && void search()}
              placeholder={t("search")}
              style={{ flex: 1, padding: "2px 8px" }}
            />
            <button onClick={() => void search()}>→</button>
          </div>
          {hits.map((h, i) => (
            <div className="row" key={i}>
              <span className="badge">{(h as { kind: string }).kind}</span>
              <span className="rule-text">{(h as { content: string }).content}</span>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
