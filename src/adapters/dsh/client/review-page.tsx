// src/adapters/dsh/client/review-page.tsx — 推广审阅页 (React)。
// 通过 connection RPC 调后端 gateway (hxMemory.reviewQueue / confirmProposal / rejectProposal / memoryQuery)。
import { useCallback, useEffect, useState } from "react";
import type { Locale } from "./locale.js";

export interface ReviewRpc {
  call(namespace: string, method: string, ...args: unknown[]): Promise<unknown>;
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

interface Props {
  rpc: ReviewRpc;
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

const NS = "hxMemory";

export function ReviewPage({ rpc, t }: Props): JSX.Element {
  const [queue, setQueue] = useState<ReviewView[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState("");
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<unknown[]>([]);
  const [tab, setTab] = useState<"props" | "recent">("props");
  const [recent, setRecent] = useState<RecentView[]>([]);
  const [recentMsg, setRecentMsg] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const list = (await rpc.call(NS, "reviewQueue", "proposed")) as ReviewView[];
      setQueue(list);
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
    extra: unknown[] = [],
  ) => {
    setMsg("");
    try {
      const res = (await rpc.call(NS, method, id, ...extra)) as { ok?: boolean; error?: string };
      if (res.ok === false) setMsg(res.error ?? "failed");
      else setMsg(method === "confirmProposal" ? t("confirmed") : t("rejected"));
      await refresh();
    } catch (e) {
      setMsg(String(e));
    }
  };

  const search = async () => {
    const q = query.trim();
    const res = (await rpc.call(NS, "memoryQuery", { text: q || undefined, limit: 20 })) as Record<
      string,
      unknown
    >[];
    setHits(res);
  };

  const refreshRecent = useCallback(async () => {
    try {
      const list = (await rpc.call(NS, "recentCaptures", 30)) as RecentView[];
      setRecent(list);
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
      const res = (await rpc.call(NS, "deleteEntry", id)) as { ok?: boolean; error?: string };
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
        <button
          style={tab === "props" ? { fontWeight: 700 } : {}}
          onClick={() => setTab("props")}
        >
          {t("tabProposals")}
        </button>
        <button
          style={tab === "recent" ? { fontWeight: 700 } : {}}
          onClick={() => setTab("recent")}
        >
          {t("tabRecent")}
        </button>
      </div>
      {tab === "recent" ? (
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
              onClick={() => void act(p.id, "confirmProposal", ["user:dsh-web"])}
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
