// src/adapters/dsh/client/files-page.tsx — **真相文件视图** (只读)。
//
// 为什么需要它 (2026-09-20, §795): ADR-002 的核心承诺是"**真相在 Markdown 文件**,
// SQLite 只是可重建的派生索引"。而面板此前的**每个视图都经 SQLite** ——
// 能搜、能删、能看注入预览, 但**没有任何入口"按文件浏览真相"**。
// 于是那条承诺在**人侧没有兑现**: 用户无法直接看到 hx-memory 到底写了什么文件、
// 写了多少、什么时候写的。而"看得见"本就是本产品的四个承诺之一。
//
// 它同时是**知识库的自然入口**: 知识库也是 .md, 用同一个渲染器就能翻阅 (见 §795 的计划)。
//
// 边界: 本页**只读**。删除/修改仍走既有的治理入口 (review / flagged / deleteEntry) ——
// 在这里加写按钮会让"真相文件"变成第二个写入路径, 那正是 ADR-002 要避免的分叉。
import { useCallback, useEffect, useState } from "react";
import type { FilesLocale } from "./locale.js";
import { callHxMemory, type HxMemoryRpcCaller } from "./rpc.js";

/** 面板对外暴露的 RPC 面。 */
export type FilesRpc = HxMemoryRpcCaller;

type T = (key: keyof FilesLocale, vars?: Record<string, unknown>) => string;

interface TruthFileInfo {
  path: string;
  dir: string;
  bytes: number;
  modifiedAt: string;
}

interface Props {
  rpc: HxMemoryRpcCaller;
  t: T;
}

/** 真相目录 (与服务端 TRUTH_VIEW_DIRS 同源; 这里只管显示顺序与标签)。 */
const DIRS = ["daily", "digest", "rules"] as const;

/** 字节 → 人类可读。 */
function human(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / 1024 / 1024).toFixed(1) + " MB";
}

/** ISO → `MM-DD HH:mm` (面板只看"什么时候写的", 不需要年份与秒)。 */
function stamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
}

export function FilesPage({ rpc, t }: Props): JSX.Element {
  const [files, setFiles] = useState<TruthFileInfo[]>([]);
  const [dir, setDir] = useState<string>("");
  const [open, setOpen] = useState<string>("");
  const [text, setText] = useState<string>("");
  const [err, setErr] = useState<string>("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setErr("");
    try {
      const list = await callHxMemory<TruthFileInfo[]>(rpc, "truthFiles", dir ? { dir } : {});
      setFiles(Array.isArray(list) ? list : []);
    } catch (e) {
      // 未挂载 (truthFiles 依赖缺席) 与"读失败"都到这里 —— 面板必须能区分"空"与"坏"。
      setErr(e instanceof Error ? e.message : String(e));
      setFiles([]);
    } finally {
      setLoading(false);
    }
  }, [rpc, dir]);

  useEffect(() => {
    void load();
  }, [load]);

  const onOpen = useCallback(
    async (path: string) => {
      if (open === path) {
        setOpen("");
        setText("");
        return;
      }
      setErr("");
      try {
        const got = await callHxMemory<{ path: string; text: string } | null>(rpc, "truthFile", { path });
        if (!got) {
          setErr(t("readDenied", { path }));
          return;
        }
        setOpen(got.path);
        setText(got.text);
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      }
    },
    [rpc, open, t],
  );

  const total = files.reduce((n, f) => n + f.bytes, 0);

  return (
    <div className="hxmem-files">
      <p className="hxmem-files-hint">{t("hint")}</p>

      <div className="hxmem-files-bar">
        <button type="button" className={dir === "" ? "on" : ""} onClick={() => setDir("")}>
          {t("allDirs")}
        </button>
        {DIRS.map((d) => (
          <button key={d} type="button" className={dir === d ? "on" : ""} onClick={() => setDir(d)}>
            {d}
          </button>
        ))}
        <span className="hxmem-files-sum">
          {t("summary", { n: files.length, size: human(total) })}
        </span>
        <button type="button" onClick={() => void load()}>
          {t("refresh")}
        </button>
      </div>

      {err ? <p className="hxmem-files-err">{err}</p> : null}
      {loading ? <p className="hxmem-files-hint">{t("loading")}</p> : null}
      {!loading && files.length === 0 && !err ? <p className="hxmem-files-hint">{t("empty")}</p> : null}

      <ul className="hxmem-files-list">
        {files.map((f) => (
          <li key={f.path}>
            <button type="button" className={open === f.path ? "on" : ""} onClick={() => void onOpen(f.path)}>
              <code>{f.path}</code>
              <span className="hxmem-files-meta">
                {human(f.bytes)} · {stamp(f.modifiedAt)}
              </span>
            </button>
            {open === f.path ? <pre className="hxmem-files-text">{text}</pre> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
