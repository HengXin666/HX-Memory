// src/adapters/dsh/client/bindings-page.tsx — 记忆绑定管理页 (VCP 式拓扑)。
// 列出 项目 → 绑定源, 支持增删改, 保存经 gateway RPC (listBindings/saveBindings)。
import { useCallback, useEffect, useState } from "react";
import type { BindingLocale } from "./locale.js";

export interface BindingRpc {
  call(namespace: string, method: string, ...args: unknown[]): Promise<unknown>;
}

interface BindingRow {
  id: string;
  query: { kind?: string; scope?: string; project?: string };
  signalWords?: string[];
}
interface ProjectBindings {
  project: string;
  bindings: BindingRow[];
}

interface Props {
  rpc: BindingRpc;
  t: (key: keyof BindingLocale, vars?: Record<string, unknown>) => string;
}

const NS = "hxMemory";
const KIND_OPTIONS = ["", "fact", "preference", "decision", "lesson", "rule", "pattern"];
const SCOPE_OPTIONS = ["", "project", "global", "agent"];

export function BindingsPage({ rpc, t }: Props): JSX.Element {
  const [configs, setConfigs] = useState<ProjectBindings[]>([]);
  const [msg, setMsg] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const list = (await rpc.call(NS, "listBindings")) as ProjectBindings[];
    setConfigs(list ?? []);
  }, [rpc]);

  useEffect(() => {
    void load();
  }, [load]);

  const addProject = () => {
    setConfigs((c) => [...c, { project: "", bindings: [] }]);
  };

  const setProject = (i: number, v: string) =>
    setConfigs((c) => c.map((x, j) => (j === i ? { ...x, project: v } : x)));
  const removeProject = (i: number) => setConfigs((c) => c.filter((_, j) => j !== i));
  const addBinding = (i: number) =>
    setConfigs((c) =>
      c.map((x, j) => (j === i ? { ...x, bindings: [...x.bindings, { id: "", query: {} }] } : x)),
    );
  const setBinding = (i: number, bi: number, patch: Partial<BindingRow>) =>
    setConfigs((c) =>
      c.map((x, j) =>
        j === i
          ? { ...x, bindings: x.bindings.map((b, k) => (k === bi ? { ...b, ...patch } : b)) }
          : x,
      ),
    );
  const removeBinding = (i: number, bi: number) =>
    setConfigs((c) =>
      c.map((x, j) => (j === i ? { ...x, bindings: x.bindings.filter((_, k) => k !== bi) } : x)),
    );

  const save = async () => {
    setSaving(true);
    setMsg("");
    try {
      // 过滤掉空项目/空绑定名; 空 project 不接受
      const clean = configs
        .filter((x) => x.project.trim())
        .map((x) => ({
          project: x.project.trim(),
          bindings: x.bindings
            .filter((b) => b.id.trim())
            .map((b) => ({
              id: b.id.trim(),
              query: {
                ...(b.query.kind ? { kind: b.query.kind } : {}),
                ...(b.query.scope ? { scope: b.query.scope } : {}),
                ...(b.query.project ? { project: b.query.project } : {}),
              },
              ...(b.signalWords?.length ? { signalWords: b.signalWords } : {}),
            })),
        }))
        .filter((x) => x.bindings.length);
      const res = (await rpc.call(NS, "saveBindings", clean)) as { ok?: boolean; error?: string };
      setMsg(res.ok === false ? t("saveFailed") + (res.error ?? "") : t("saved"));
      await load();
    } catch (e) {
      setMsg(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="hxmem-bindings">
      <h3>{t("title")}</h3>
      <p className="meta">{t("desc")}</p>
      {msg ? <div className="meta">{msg}</div> : null}
      {configs.length === 0 ? (
        <div className="empty">{t("noProjects")}</div>
      ) : (
        configs.map((cfg, i) => (
          <div className="row" key={i}>
            <input
              className="proj"
              value={cfg.project}
              placeholder={t("projectPh")}
              onChange={(e) => setProject(i, (e.target as HTMLInputElement).value)}
              style={{ width: 120, fontWeight: 600 }}
            />
            <span style={{ flex: 1 }}>
              {cfg.bindings.map((b, bi) => (
                <div
                  key={bi}
                  style={{ display: "flex", gap: 6, marginBottom: 4, flexWrap: "wrap" }}
                >
                  <input
                    value={b.id}
                    placeholder={t("bindingId")}
                    style={{ width: 130 }}
                    onChange={(e) =>
                      setBinding(i, bi, { id: (e.target as HTMLInputElement).value })
                    }
                  />
                  <select
                    value={b.query.kind ?? ""}
                    style={{ width: 90 }}
                    onChange={(e) =>
                      setBinding(i, bi, {
                        query: {
                          ...b.query,
                          kind: (e.target as HTMLSelectElement).value || undefined,
                        },
                      })
                    }
                  >
                    {KIND_OPTIONS.map((k) => (
                      <option key={k} value={k}>
                        {k || t("any")}
                      </option>
                    ))}
                  </select>
                  <select
                    value={b.query.scope ?? ""}
                    style={{ width: 80 }}
                    onChange={(e) =>
                      setBinding(i, bi, {
                        query: {
                          ...b.query,
                          scope: (e.target as HTMLSelectElement).value || undefined,
                        },
                      })
                    }
                  >
                    {SCOPE_OPTIONS.map((s) => (
                      <option key={s} value={s}>
                        {s || t("any")}
                      </option>
                    ))}
                  </select>
                  <input
                    value={(b.signalWords ?? []).join(",")}
                    placeholder={t("signalWords")}
                    style={{ flex: 1, minWidth: 140 }}
                    onChange={(e) => {
                      const words = (e.target as HTMLInputElement).value
                        .split(",")
                        .map((w) => w.trim())
                        .filter(Boolean);
                      setBinding(i, bi, { signalWords: words.length ? words : undefined });
                    }}
                  />
                  <button onClick={() => removeBinding(i, bi)}>{t("remove")}</button>
                </div>
              ))}
              <button onClick={() => addBinding(i)} style={{ fontSize: 12 }}>
                + {t("addBinding")}
              </button>
            </span>
            <button onClick={() => removeProject(i)}>{t("remove")}</button>
          </div>
        ))
      )}
      <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
        <button onClick={addProject}>{t("addProject")}</button>
        <button className="confirm" onClick={() => void save()} disabled={saving}>
          {t("save")}
        </button>
      </div>
    </div>
  );
}
