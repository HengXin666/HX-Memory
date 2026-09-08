// src/adapters/dsh/client/bindings-page.tsx — 记忆绑定管理页 (VCP 式拓扑)。
// 列出 项目 → 绑定源, 支持增删改, 保存经 gateway RPC (listBindings/saveBindings)。
// 字段保真: 面板只编辑 id/kind/scope/project/weight/max/signalWords, 其余字段原样透传,
// 避免"面板保存一次就抹掉手工写的配置"。
import { useCallback, useEffect, useState } from "react";
import type { BindingLocale } from "./locale.js";
import { callHxMemory, type HxMemoryRpcCaller } from "./rpc.js";

/** 面板对外暴露的 RPC 面 (供 index.tsx 类型收敛)。 */
export type BindingRpc = HxMemoryRpcCaller;

interface BindingRow {
  id: string;
  query: { kind?: string; scope?: string; project?: string; [k: string]: unknown };
  weight?: number;
  max?: number;
  signalWords?: string[];
  [k: string]: unknown;
}
interface ProjectBindings {
  project: string;
  bindings: BindingRow[];
  [k: string]: unknown;
}

interface Props {
  rpc: HxMemoryRpcCaller;
  t: (key: keyof BindingLocale, vars?: Record<string, unknown>) => string;
}

const KIND_OPTIONS = ["", "fact", "preference", "decision", "lesson", "rule", "pattern"];
const SCOPE_OPTIONS = ["", "project", "global", "agent"];

/** 去掉 undefined 字段 (宿主只接受 JSON, undefined 会在序列化时消失但显式清理更稳)。 */
function compact<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out as T;
}

export function BindingsPage({ rpc, t }: Props): JSX.Element {
  const [configs, setConfigs] = useState<ProjectBindings[]>([]);
  const [msg, setMsg] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const list = await callHxMemory<ProjectBindings[]>(rpc, "listBindings");
      setConfigs(list ?? []);
    } catch (e) {
      setMsg(String(e));
      setConfigs([]);
    }
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
      // 过滤掉空项目/空绑定名; 其余字段 (含未知字段) 原样保留。
      const clean = configs
        .filter((x) => x.project.trim())
        .map((x) => ({
          ...compact(x),
          project: x.project.trim(),
          bindings: x.bindings
            .filter((b) => b.id.trim())
            .map((b) =>
              compact({
                ...b,
                id: b.id.trim(),
                query: compact({
                  ...b.query,
                  kind: b.query.kind || undefined,
                  scope: b.query.scope || undefined,
                  project: b.query.project || undefined,
                }),
                weight: b.weight,
                max: b.max,
                signalWords: b.signalWords?.length ? b.signalWords : undefined,
              }),
            ),
        }))
        .filter((x) => x.bindings.length);
      const res = await callHxMemory<{ ok?: boolean; error?: string }>(rpc, "saveBindings", {
        configs: clean,
      });
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
      <p className="meta">{t("projectHint")}</p>
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
                    value={b.weight === undefined ? "" : String(b.weight)}
                    placeholder={t("weight")}
                    style={{ width: 60 }}
                    onChange={(e) => {
                      const raw = (e.target as HTMLInputElement).value.trim();
                      const n = raw === "" ? undefined : Number(raw);
                      setBinding(i, bi, {
                        weight: n !== undefined && Number.isFinite(n) ? n : undefined,
                      });
                    }}
                  />
                  <input
                    value={b.max === undefined ? "" : String(b.max)}
                    placeholder={t("max")}
                    style={{ width: 60 }}
                    onChange={(e) => {
                      const raw = (e.target as HTMLInputElement).value.trim();
                      const n = raw === "" ? undefined : Number(raw);
                      setBinding(i, bi, {
                        max: n !== undefined && Number.isFinite(n) ? n : undefined,
                      });
                    }}
                  />
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
