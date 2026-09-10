// src/adapters/dsh/client/bindings-page.tsx — 记忆绑定管理页 (VCP 式拓扑)。
// 列出 项目 → 绑定源, 支持增删改, 保存经 gateway RPC (listBindings/saveBindings)。
//
// 低负担优先 (用户反馈"字段太多"):
//   1) 一键模板: 点一下直接往当前项目追加一条现成绑定, 不用填 6 个字段;
//   2) 当前项目行自动建好 (名字取自宿主会话 cwd 的目录名);
//   3) 默认只显示 id/类型/范围/信号词, 权重/上限/项目过滤收进"高级"。
// 字段保真: 面板只编辑这些字段, 其余字段原样透传,
// 避免"面板保存一次就抹掉手工写的配置"。
import { useCallback, useEffect, useRef, useState } from "react";
import type { BindingLocale } from "./locale.js";
import { callHxMemory, type HxMemoryRpcCaller } from "./rpc.js";

/** 面板对外暴露的 RPC 面 (供 index.tsx 类型收敛)。 */
export type BindingRpc = HxMemoryRpcCaller;

type T = (key: keyof BindingLocale, vars?: Record<string, unknown>) => string;

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
  t: T;
}

const KIND_OPTIONS = ["", "fact", "preference", "decision", "lesson", "rule", "pattern"];
const SCOPE_OPTIONS = ["", "project", "global", "agent"];

/** 一键模板: 每个模板就是一条完整绑定, 追加进当前项目即可用。 */
const PRESETS: readonly { key: keyof BindingLocale; id: string; query: BindingRow["query"] }[] = [
  { key: "presetCrossRules", id: "cross-rules", query: { kind: "rule", scope: "global" } },
  { key: "presetProjectLessons", id: "project-lessons", query: { kind: "lesson", scope: "project" } },
  { key: "presetSharedAgent", id: "shared-agent", query: { scope: "agent" } },
  {
    key: "presetLessonsDecisions",
    id: "lessons-decisions",
    query: { kind: "lesson", scope: "project" },
  },
];

/** 去掉 undefined 字段 (宿主只接受 JSON, undefined 会在序列化时消失但显式清理更稳)。 */
function compact<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out as T;
}

/**
 * 问宿主要当前会话的项目键 (cwd 的目录名)。
 *
 * 注意: 浏览器侧的 rpc 只有 { call }, 读不到 cwd —— 项目名必须走 currentProject 这个
 * gateway 方法 (VCP 的 binding project 键 = 会话目录名)。拿不到 (没有活动会话 / 方法还不存在 /
 * 网络失败) 一律返回空串: 面板照常可用, 只是不自动建行, 也不弹错误横幅。
 */
async function fetchCurrentProject(rpc: HxMemoryRpcCaller): Promise<string> {
  try {
    const res = await callHxMemory<{ project?: string }>(rpc, "currentProject");
    const name = res?.project;
    return typeof name === "string" ? name.trim() : "";
  } catch {
    return "";
  }
}

export function BindingsPage({ rpc, t }: Props): JSX.Element {
  const [configs, setConfigs] = useState<ProjectBindings[]>([]);
  const [msg, setMsg] = useState("");
  const [saving, setSaving] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  const loadedRef = useRef(false);
  const autoRef = useRef("");
  const [autoProject, setAutoProject] = useState("");

  const load = useCallback(async () => {
    try {
      const list = await callHxMemory<ProjectBindings[]>(rpc, "listBindings");
      // 首次拉取时若当前项目还没有行, 就地补一行空项目 —— 新用户才有"一键可用"的落点。
      let next = list ?? [];
      const auto = autoRef.current;
      if (!loadedRef.current && auto && !next.some((c) => c.project === auto)) {
        next = [...next, { project: auto, bindings: [] }];
      }
      loadedRef.current = true;
      setConfigs(next);
      dirtyRef.current = false; // 刚从后端拉过, 当前编辑状态与后端一致
      setDirty(false);
    } catch (e) {
      setMsg(String(e));
      setConfigs([]);
    }
  }, [rpc]);

  // 当前项目名只在挂载时算一次 (会话切换会重挂载这个面板, 不需要订阅)。
  // 先拿到名字再拉绑定列表 —— 否则首次 load 时 autoRef 还是空的, 自动行会错过。
  useEffect(() => {
    let alive = true;
    void fetchCurrentProject(rpc).then((name) => {
      if (!alive) return;
      autoRef.current = name;
      setAutoProject(name);
      void load();
    });
    return () => {
      alive = false;
    };
  }, [rpc, load]);

  /**
   * 打开期间跟随后端变化 (别的窗口/CLI 改了绑定也应该看到)。
   * 与审阅页同一策略: focus + visibilitychange + 可见时轮询。
   * 注意: 用户正在编辑时**不要**覆盖输入框 —— 有未保存改动就跳过自动刷新。
   */
  useEffect(() => {
    const auto = () => {
      if (!dirtyRef.current && document.visibilityState === "visible") void load();
    };
    window.addEventListener("focus", auto);
    document.addEventListener("visibilitychange", auto);
    const timer = setInterval(auto, 5000);
    return () => {
      window.removeEventListener("focus", auto);
      document.removeEventListener("visibilitychange", auto);
      clearInterval(timer);
    };
  }, [load]);

  // 所有编辑入口都置脏: 有未保存改动时自动刷新会跳过, 避免覆盖用户正在输入的内容。
  // ref 是闸门 (不需要渲染), state 只负责那条"自动刷新已暂停"的提示。
  const markDirty = () => {
    dirtyRef.current = true;
    setDirty(true);
  };

  const addProject = () => {
    markDirty();
    setConfigs((c) => [...c, { project: "", bindings: [] }]);
  };

  const setProject = (i: number, v: string) => {
    markDirty();
    setConfigs((c) => c.map((x, j) => (j === i ? { ...x, project: v } : x)));
  };
  const removeProject = (i: number) => {
    markDirty();
    setConfigs((c) => c.filter((_, j) => j !== i));
  };
  const addBinding = (i: number) => {
    markDirty();
    setConfigs((c) =>
      c.map((x, j) => (j === i ? { ...x, bindings: [...x.bindings, { id: "", query: {} }] } : x)),
    );
  };
  const setBinding = (i: number, bi: number, patch: Partial<BindingRow>) => {
    markDirty();
    setConfigs((c) =>
      c.map((x, j) =>
        j === i
          ? { ...x, bindings: x.bindings.map((b, k) => (k === bi ? { ...b, ...patch } : b)) }
          : x,
      ),
    );
  };
  const removeBinding = (i: number, bi: number) => {
    markDirty();
    setConfigs((c) =>
      c.map((x, j) => (j === i ? { ...x, bindings: x.bindings.filter((_, k) => k !== bi) } : x)),
    );
  };

  /**
   * 一键模板: 追加到当前项目行。
   * 没匹配到项目 (用户改了名字/删了行) 就落到"第一个项目", 一个都没有才新建。
   * 同 id 已存在时不重复追加, 只提示 —— 避免连点两下产生重复绑定。
   */
  const applyPreset = (preset: (typeof PRESETS)[number]) => {
    const named = autoProject;
    const label = t(preset.key);
    const fresh: BindingRow = { id: preset.id, query: { ...preset.query } };
    markDirty();

    // 找当前项目行; 用户改名/删行后退化成"第一个有名字的项目", 再退化成第一行。
    let idx = named ? configs.findIndex((x) => x.project === named) : -1;
    if (idx < 0) idx = configs.findIndex((x) => x.project.trim() !== "");
    if (idx < 0 && configs.length > 0) idx = 0;
    if (idx < 0) {
      setConfigs([{ project: named, bindings: [fresh] }]);
      setMsg(t("presetAdded", { name: label }));
      return;
    }

    const target = configs[idx] as ProjectBindings;
    if (target.bindings.some((b) => b.id === preset.id)) {
      setMsg(t("presetDupe", { name: label, project: target.project || t("presetUntitled") }));
      return;
    }
    setConfigs(configs.map((x, j) => (j === idx ? { ...x, bindings: [...x.bindings, fresh] } : x)));
    setMsg(t("presetAdded", { name: label }));
  };

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
      await load(); // load 会把 dirty 复位
    } catch (e) {
      setMsg(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="hxmem-bindings">
      <div className="head">
        <div>
          <h3>{t("title")}</h3>
          <p className="hint">{t("desc")}</p>
        </div>
        <label className="toggle">
          <input
            type="checkbox"
            checked={advanced}
            onChange={(e) => setAdvanced((e.target as HTMLInputElement).checked)}
          />
          <span>{t("advanced")}</span>
        </label>
      </div>

      <div className="presets">
        <div className="presets-head">
          <span className="presets-title">{t("presets")}</span>
          <span className="meta">
            {t("presetHint", { project: autoProject || t("presetUntitled") })}
          </span>
        </div>
        <div className="preset-buttons">
          {PRESETS.map((p) => (
            <button type="button" className="chip" key={p.id} onClick={() => applyPreset(p)}>
              {t(p.key)}
            </button>
          ))}
        </div>
        {advanced ? <p className="hint">{t("advancedHint")}</p> : null}
      </div>

      {msg ? <div className="banner info">{msg}</div> : null}
      {dirty ? <div className="banner warn">{t("dirty")}</div> : null}

      {configs.length === 0 ? (
        <div className="empty">
          <div>{t("noProjects")}</div>
          <div className="meta">{t("twoStepHint")}</div>
        </div>
      ) : (
        <div className="projects">
          {configs.map((cfg, i) => {
            const isCurrent = autoProject !== "" && cfg.project === autoProject;
            return (
              <div className={"project" + (isCurrent ? " current" : "")} key={i}>
                <div className="project-head">
                  <input
                    className="proj"
                    value={cfg.project}
                    placeholder={t("projectPh")}
                    onChange={(e) => setProject(i, (e.target as HTMLInputElement).value)}
                  />
                  {isCurrent ? <span className="badge soft">{t("currentProjectTag")}</span> : null}
                  <span className="meta">
                    {t("bindingsCount", { n: String(cfg.bindings.length) })}
                  </span>
                  <span className="spacer" />
                  <button type="button" className="ghost" onClick={() => addBinding(i)}>
                    + {t("addBinding")}
                  </button>
                  <button
                    type="button"
                    className="danger"
                    onClick={() => removeProject(i)}
                    title={t("removeProject")}
                  >
                    {t("remove")}
                  </button>
                </div>

                {cfg.bindings.length === 0 ? (
                  <div className="empty small">{t("noBindings")}</div>
                ) : (
                  cfg.bindings.map((b, bi) => (
                    <div className="field-row" key={bi}>
                      <label className="field">
                        <span className="field-label">{t("bindingId")}</span>
                        <input
                          value={b.id}
                          placeholder={t("bindingId")}
                          onChange={(e) =>
                            setBinding(i, bi, { id: (e.target as HTMLInputElement).value })
                          }
                        />
                      </label>
                      <label className="field">
                        <span className="field-label">{t("kind")}</span>
                        <select
                          value={b.query.kind ?? ""}
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
                      </label>
                      <label className="field">
                        <span className="field-label">{t("scope")}</span>
                        <select
                          value={b.query.scope ?? ""}
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
                      </label>
                      <label className="field grow">
                        <span className="field-label">{t("signalWords")}</span>
                        <input
                          value={(b.signalWords ?? []).join(",")}
                          placeholder={t("signalWords")}
                          onChange={(e) => {
                            const words = (e.target as HTMLInputElement).value
                              .split(",")
                              .map((w) => w.trim())
                              .filter(Boolean);
                            setBinding(i, bi, { signalWords: words.length ? words : undefined });
                          }}
                        />
                      </label>

                      {advanced ? (
                        <>
                          <label className="field">
                            <span className="field-label">{t("weight")}</span>
                            <input
                              value={b.weight === undefined ? "" : String(b.weight)}
                              placeholder={t("weight")}
                              onChange={(e) => {
                                const raw = (e.target as HTMLInputElement).value.trim();
                                const n = raw === "" ? undefined : Number(raw);
                                setBinding(i, bi, {
                                  weight: n !== undefined && Number.isFinite(n) ? n : undefined,
                                });
                              }}
                            />
                          </label>
                          <label className="field">
                            <span className="field-label">{t("max")}</span>
                            <input
                              value={b.max === undefined ? "" : String(b.max)}
                              placeholder={t("max")}
                              onChange={(e) => {
                                const raw = (e.target as HTMLInputElement).value.trim();
                                const n = raw === "" ? undefined : Number(raw);
                                setBinding(i, bi, {
                                  max: n !== undefined && Number.isFinite(n) ? n : undefined,
                                });
                              }}
                            />
                          </label>
                          <label className="field">
                            <span className="field-label">{t("projectFilter")}</span>
                            <input
                              value={b.query.project ?? ""}
                              placeholder={t("projectFilter")}
                              onChange={(e) =>
                                setBinding(i, bi, {
                                  query: {
                                    ...b.query,
                                    project: (e.target as HTMLInputElement).value || undefined,
                                  },
                                })
                              }
                            />
                          </label>
                        </>
                      ) : null}

                      <button
                        type="button"
                        className="danger"
                        onClick={() => removeBinding(i, bi)}
                        title={t("remove")}
                      >
                        {t("remove")}
                      </button>
                    </div>
                  ))
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="foot">
        <button type="button" className="ghost" onClick={addProject}>
          {t("addProject")}
        </button>
        <button type="button" className="primary" onClick={() => void save()} disabled={saving}>
          {saving ? t("loading") : t("save")}
        </button>
        <span className="meta">{t("saveHint")}</span>
      </div>
    </div>
  );
}
