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
import { isStaleHostError, readCovers } from "./review-covers.js";

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
  /**
   * 被这条提议概括的实例。**新宿主给 id 数组, 旧宿主给计数** —— 面板必须两种都收
   * (类型标成 unknown, 由 readCovers 归一化): 宿主进程比面板活得久, 只重建 dist 不重启
   * 宿主时就会遇到旧契约, 直接 .slice() 会抛 TypeError (实测)。见 review-covers.ts。
   */
  covers: unknown;
  confidence: number;
  sourceRun: string;
  generatedAt: string;
  suggestedAction: "confirm" | "rewrite" | "reject";
  /** true = 启发式占位草稿 (没走 AI 提炼), 必须人工重写后才值得确认。 */
  drafted: boolean;
}

/** 人审展开时的一条实例 (被 covers 引用的原文)。 */
interface ReviewEntryView {
  id: string;
  kind: string;
  content: string;
  project?: string;
  scope: string;
  status: string;
  assertedAt: string;
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

/**
 * 一条记忆的证据链 (与 facade.evidenceChain 同形)。
 *
 * 为什么面板需要它: "可溯源"是本产品的核心承诺, 而此前**人侧没有任何入口** ——
 * 只有 agent 能通过 memory_evidence 工具追到原话。人看到一条结论却查不到它的出处,
 * 就没法判断该不该改它, 也就谈不上"用户握有最终编辑权"。
 */
interface EvidenceEpisode {
  id: string;
  role: string;
  text: string;
  at: string;
  turn: number;
}

interface EvidenceChainView {
  entryId: string;
  content: string;
  source: string;
  episodeIds: string[];
  episodes: EvidenceEpisode[];
  /** 是否完整可溯源 (false 时 reasons 说明缺在哪)。 */
  traceable: boolean;
  reasons: string[];
}

/** 一条待审的捕获候选 (与 capture/review-queue.ts 的 CaptureReviewItem 同形)。 */
/**
 * 注入预览 (服务端 alwaysOnPreview 的投影)。
 *
 * `blocked` 是本出口存在的原因: 规则是用户确认过的不变量, 而保底通道的承诺是无条件注入 ——
 * 实测真实库 9 条已确认规则里 **2 条因配额永远注入不进**, 且完全静默。
 * 面板必须把它们列出来 (含成因), 否则用户只能看到"我确认过这条规则, 但它好像没生效"。
 */
interface InjectionPreviewView {
  picked: Array<{ id: string; kind: string; scope: string; content: string; tokens: number }>;
  blocked: Array<{ id: string; kind: string; content: string; tokens: number; reason: string }>;
  budgetTokens: number;
  selectedTokens: number;
}

interface CaptureReviewView {
  id: string;
  at: string;
  /** 为什么进待审 (可审计: 多条并列)。 */
  reasons: string[];
  question: string;
  conclusion: string;
  answerExcerpt: string;
  project?: string;
  session: string;
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

/** 调度账本的一条记录 (与 gateway.scheduleLog 的 ScheduleRecord 同形)。 */
interface SchedRecord {
  at: string;
  session: string;
  project?: string;
  step: number;
  channel: "binding" | "trigger" | "none";
  mode: string | null;
  outcome: "injected" | "skipped" | "nothing-new" | "empty";
  intent: string | null;
  confidence: number;
  topicDrift: number;
  reason: string;
  selected: string[];
  ids: string[];
  tokens: number;
}

/** 按会话聚合后的调度行。 */
interface SchedSession {
  session: string;
  project?: string;
  firstAt: string;
  lastAt: string;
  steps: number;
  injected: number;
  skipped: number;
  tokens: number;
  modes: Record<string, number>;
  lastMode: string | null;
  lastOutcome: SchedRecord["outcome"];
  lastReason: string;
  lastIds: string[];
}

interface SchedView {
  available: boolean;
  sessions: SchedSession[];
  records: SchedRecord[];
  size: { files: number; records: number };
}

/** 后台维护记录 (P3 调度器): 面板要看的是"它跑了没有/成功没有", 而不是参数细节。 */
interface MaintRecord {
  at: string;
  tasks: string[];
  ok: boolean;
  detail: string;
  output?: string;
  elapsedMs: number;
}

interface MaintView {
  enabled: boolean;
  available: boolean;
  intervalMs: number;
  idleMs: number;
  records: MaintRecord[];
}

/** 捕获耗时账本的一条记录 (与 gateway.captureLog 的 CaptureRecord 同形)。 */
interface CapRecord {
  at: string;
  session: string;
  project?: string;
  turn: number;
  outcome: "stored" | "skipped" | "error";
  skip?: string;
  entries: number;
  qChars: number;
  aChars: number;
  episodeMs: number;
  enrichMs: number;
  linkMs: number;
  storeMs: number;
  totalMs: number;
  detail?: string;
}

interface CapStats {
  count: number;
  skipped: number;
  errors: number;
  totalMs: { p50: number; p95: number; max: number };
  mean: { episodeMs: number; enrichMs: number; linkMs: number; storeMs: number };
  slowest?: CapRecord;
}

interface CapView {
  available: boolean;
  stats: CapStats;
  records: CapRecord[];
  size: { files: number; records: number };
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

/**
 * 跳过的原因 → 人可读标签。
 *
 * 为什么要区分这些: "这轮没沉淀"有五种完全不同的成因, 而处置方式相反
 * (改设置 / 换会话 / 根本不用管)。把它们显示成同一个"没沉淀"等于没解释。
 */
function skipLabel(skip: string | undefined, t: (k: never, v?: Record<string, string>) => string): string {
  const key =
    skip === "disabled"
      ? "captureSkipDisabled"
      : skip === "subagent"
        ? "captureSkipSubagent"
        : skip === "no-turn"
          ? "captureSkipNoTurn"
          : skip === "no-conclusion"
            ? "captureSkipNoConclusion"
            : "captureSkipNoSignal";
  return (t as unknown as (k: string) => string)(key);
}

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
  const [tab, setTab] = useState<
    "props" | "recent" | "review" | "inv" | "flagged" | "sched" | "cost" | "inject"
  >("props");
  const [sched, setSched] = useState<SchedView | null>(null);
  const [maint, setMaint] = useState<MaintView | null>(null);
  const [cost, setCost] = useState<CapView | null>(null);
  const [inv, setInv] = useState<InvocationView[]>([]);
  const [flagged, setFlagged] = useState<FlaggedView[]>([]);
  /** 待审队列: available=false 表示端点未接线 (与"没有待审"是两件事)。 */
  const [captureReview, setCaptureReview] = useState<{ available: boolean; items: CaptureReviewView[] } | null>(null);
  /** 注入预览: null = 尚未拉取; 用 blocked 显式列出"因配额没进来"的条目。 */
  const [injectView, setInjectView] = useState<InjectionPreviewView | null>(null);
  const [recent, setRecent] = useState<RecentView[]>([]);
  const [recentMsg, setRecentMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [busySince, setBusySince] = useState(0);
  const [now, setNow] = useState(0);
  const [report, setReport] = useState<BatchReport | null>(null);
  const [status, setStatus] = useState<GenStatus | null>(null);
  const [statusErr, setStatusErr] = useState("");
  /** 已展开的提议 id (展开时按需取原文, 不是全量预取 —— 队列可能很长)。 */
  const [open, setOpen] = useState<Record<string, ReviewEntryView[] | "loading" | "error">>({});
  /** 宿主不认识 entriesByIds (面板比宿主新, 通常是宿主没重启): 提示一次, 不再逐条报错。 */
  const [staleHost, setStaleHost] = useState(false);
  /**
   * 已展开证据链的记忆 id → 链路或状态。
   * 按需取 (不是全量预取): 每条都要读 episode 日志, 全量预取会把面板拖垮 ——
   * 与 open (审阅展开) 同一取舍。
   */
  const [evidence, setEvidence] = useState<
    Record<string, EvidenceChainView | "loading" | "error">
  >({});

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

  /**
   * 展开一条提议: 把它概括的实例原文取回来。
   *
   * 为什么必须能展开: 提议行本身只有一句被抽象出来的规则, 而人审要判断的恰恰是
   * "它概括的那几条到底在说什么"。此前接口只回 covers 计数 —— 用户看到
   * "覆盖 3 条实例" 时无从判断该确认还是驳回 (实测的真实困扰, 也是本页要消灭的
   * 那一类"不可解释")。取回的内容会缓存, 收起再展开不重复请求。
   */
  const toggle = async (p: ReviewView) => {
    if (open[p.id]) {
      setOpen((s) => {
        const next = { ...s };
        delete next[p.id];
        return next;
      });
      return;
    }
    // 旧宿主只有计数: 展开这件事根本做不到, 直说而不是发一次注定失败的请求。
    const covers = readCovers(p.covers);
    if (covers.legacy) {
      setStaleHost(true);
      return;
    }
    setOpen((s) => ({ ...s, [p.id]: "loading" }));
    try {
      const rows = await callHxMemory<ReviewEntryView[]>(rpc, "entriesByIds", {
        ids: covers.ids.slice(0, 100),
      });
      setOpen((s) => ({ ...s, [p.id]: Array.isArray(rows) ? rows : [] }));
    } catch (e) {
      // 宿主不认识这个出口 (= 面板比宿主新) 是**部署状态**, 不是数据问题:
      // 提示"重启宿主", 而不是把用户引向"这条提议没有实例"的错误结论。
      if (isStaleHostError(e)) setStaleHost(true);
      setOpen((s) => ({ ...s, [p.id]: "error" }));
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

  const refreshInjection = useCallback(async () => {
    try {
      // 浏览器侧的 rpc 只有 { call }, 读不到 cwd —— 项目名必须走 currentProject (与绑定页同一做法;
      // 面板曾试图读 rpc.cwd 这个不存在的字段, 于是自动建行永远不生效)。
      // 项目为空时端点按"没有项目"处理 (只给跨项目规则) —— 那是正确降级, 不是错误。
      const cur = await callHxMemory<{ project?: string }>(rpc, "currentProject");
      setInjectView(
        await callHxMemory<InjectionPreviewView>(rpc, "alwaysOnPreview", { project: cur?.project ?? "" }),
      );
    } catch {
      setInjectView(null);
    }
  }, [rpc]);

  useEffect(() => {
    if (tab === "inject") void refreshInjection();
  }, [tab, refreshInjection]);

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

  const refreshSched = useCallback(async () => {
    try {
      const view = await callHxMemory<SchedView>(rpc, "scheduleLog", { limit: 120 });
      setSched(view ?? null);
    } catch {
      // 老 gateway 没有这个方法时页面照常可用 (与批次状态栏同一策略)。
      setSched(null);
    }
    try {
      const m = await callHxMemory<MaintView>(rpc, "maintenance");
      setMaint(m ?? null);
    } catch {
      setMaint(null);
    }
  }, [rpc]);

  useEffect(() => {
    if (tab === "sched") void refreshSched();
  }, [tab, refreshSched]);

  const refreshCost = useCallback(async () => {
    try {
      const view = await callHxMemory<CapView>(rpc, "captureLog", { limit: 120 });
      setCost(view ?? null);
    } catch {
      // 老 gateway 没有这个方法时页面照常可用 (与调度账本同一策略)。
      setCost(null);
    }
  }, [rpc]);

  useEffect(() => {
    if (tab === "cost") void refreshCost();
  }, [tab, refreshCost]);

  /**
   * 展开/收起一条记忆的证据链 (追到产生它的原始对话原话)。
   *
   * 降级要可见: 宿主未重启 (不认识该端点) 时给出与 staleHost 同类的一次性提示,
   * 而不是逐条报错 —— 宿主进程比面板活得久是常态。
   */
  const toggleEvidence = async (id: string) => {
    if (evidence[id] && evidence[id] !== "loading") {
      setEvidence((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      return;
    }
    setEvidence((prev) => ({ ...prev, [id]: "loading" }));
    try {
      const chain = await callHxMemory<EvidenceChainView>(rpc, "evidenceChain", { id });
      setEvidence((prev) => ({ ...prev, [id]: chain }));
    } catch (e) {
      setEvidence((prev) => ({ ...prev, [id]: "error" }));
      setRecentMsg(String(e));
    }
  };

  /** 拉取待审队列 (按需, 切到该 tab 时才读 —— 与其它 tab 同一取舍)。 */
  const refreshCaptureReview = useCallback(async () => {
    try {
      const res = await callHxMemory<{ available: boolean; items: CaptureReviewView[] }>(
        rpc,
        "captureReviewQueue",
        { limit: 50 },
      );
      setCaptureReview(res ?? { available: false, items: [] });
    } catch {
      // 宿主未重启 (不认识该端点) → 显示为未接线而不是空队列。
      setCaptureReview({ available: false, items: [] });
    }
  }, [rpc]);

  /**
   * 审核裁决: keep (确认保留) 或 drop (**从记忆里剔除**)。
   *
   * ⚠ 语义在 2026-10-05 反转 (用户要求: "审核机制是用于剔除你的记忆, 而不是说阻止你的记忆
   * 加入到记忆中"): 队列里的条目**已经入库**, 因此:
   *   · keep  = 确认留下 (它本来就在库里, 不重复写);
   *   · drop  = 真的剔除 (服务端写 shadow; 只改队列状态会让"剔除"变成一句空话)。
   * 旧动作名 accept/reject 在服务端仍被接受并映射到同一套新语义 (兼容既有调用点)。
   */
  const resolveReview = async (id: string, action: "keep" | "drop") => {
    setRecentMsg("");
    try {
      const res = await callHxMemory<{ ok?: boolean; error?: string }>(
        rpc,
        "resolveCaptureReview",
        { id, action },
      );
      if (res.ok === false) setRecentMsg(res.error ?? "failed");
      await refreshCaptureReview();
    } catch (e) {
      setRecentMsg(String(e));
    }
  };

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

  useEffect(() => {
    if (tab === "review") void refreshCaptureReview();
  }, [tab, refreshCaptureReview]);

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
          aria-selected={tab === "review"}
          className={tab === "review" ? "tab on" : "tab"}
          onClick={() => setTab("review")}
        >
          {t("tabCaptureReview")}
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
        <button
          type="button"
          role="tab"
          aria-selected={tab === "sched"}
          className={tab === "sched" ? "tab on" : "tab"}
          onClick={() => setTab("sched")}
        >
          {t("tabSchedule")}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "cost"}
          className={tab === "cost" ? "tab on" : "tab"}
          onClick={() => setTab("cost")}
        >
          {t("tabCaptureCost")}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "inject"}
          className={tab === "inject" ? "tab on" : "tab"}
          onClick={() => setTab("inject")}
        >
          {t("tabInjection")}
        </button>
      </div>

      {tab === "inject" ? (
        <section className="pane">
          <p className="hint">{t("injHint")}</p>
          {injectView === null ? (
            <p className="hint">{t("injUnavailable")}</p>
          ) : injectView.picked.length === 0 && injectView.blocked.length === 0 ? (
            <p className="hint">{t("injEmpty")}</p>
          ) : (
            <>
              <p className="hint">
                {t("injBudget")}: {injectView.budgetTokens} · {t("injUsed")}: {injectView.selectedTokens}
              </p>
              <h4>{t("injPicked")}</h4>
              <ul className="list">
                {injectView.picked.map((e) => (
                  <li key={e.id}>
                    <span className="badge soft">{e.kind}</span>
                    <span className="badge soft">{e.tokens}</span> {e.content}
                  </li>
                ))}
              </ul>
              {/* 被配额挡掉的**必须显式列出**: 规则承诺无条件注入, 静默失效是用户唯一
                  无法自行发现的故障 —— 他只会觉得"我确认过这条, 但它好像没生效"。 */}
              {injectView.blocked.length ? (
                <>
                  <h4>{t("injBlocked")}</h4>
                  <ul className="list">
                    {injectView.blocked.map((b) => (
                      <li key={b.id}>
                        <span className="badge soft">{b.kind === "rule" ? "rule" : b.kind}</span>
                        <span className="badge soft">
                          {b.reason === "over-group-cap" ? t("injReasonGroupCap") : t("injReasonTotalBudget")}
                        </span>
                        <span className="badge soft">{b.tokens}</span> {b.content}
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
            </>
          )}
        </section>
      ) : null}

      {tab === "sched" ? (
        <section className="pane">
          <div className="status-head">
            <span className="status-title">{t("tabSchedule")}</span>
            {sched?.available ? (
              <span className="badge soft">
                {t("schedSize", {
                  files: String(sched.size.files),
                  records: String(sched.size.records),
                })}
              </span>
            ) : null}
            <button type="button" className="ghost" onClick={() => void refreshSched()}>
              {t("schedRefresh")}
            </button>
          </div>
          <p className="hint">{t("schedHint")}</p>

          {/* 后台维护 (P3 调度器): 它"悄悄发生", 所以必须有一处能看见 —— 没有这块,
              用户无法区分"维护在正常工作"和"它从来没跑过"(两者在界面上都一样安静)。 */}
          <h3 className="section-title">{t("maintTitle")}</h3>
          {!maint ? (
            <div className="empty">{t("maintUnavailable")}</div>
          ) : (
            <>
              <div className="status-head">
                <span
                  className={"badge " + (maint.enabled && maint.available ? "confirmed" : "soft")}
                >
                  {!maint.enabled
                    ? t("maintOff")
                    : maint.available
                      ? t("maintOn", { h: String(Math.round(maint.intervalMs / 3_600_000)) })
                      : t("maintNoCli")}
                </span>
                <span className="meta">
                  {t("maintIdle", { m: String(Math.round(maint.idleMs / 60_000)) })}
                </span>
                <button type="button" className="ghost" onClick={() => void refreshSched()}>
                  {t("schedRefresh")}
                </button>
              </div>
              <p className="hint">{t("maintHint")}</p>
              {maint.records.length === 0 ? (
                <div className="empty">{t("maintEmpty")}</div>
              ) : (
                <div className="list">
                  {maint.records.map((r, i) => (
                    <div className="row" key={r.at + ":" + String(i)}>
                      <span className={"badge " + (r.ok ? "confirmed" : "rejected")}>
                        {r.ok ? t("maintOk") : t("maintFailed")}
                      </span>
                      <span className="content">{r.tasks.join(", ")}</span>
                      <span className="meta">
                        {r.detail} · {t("maintTook", { ms: String(r.elapsedMs) })} · {stamp(r.at)}
                      </span>
                      {/* 失败必须带上子进程输出: 只有 "exit:1" 等于没有证据 (踩过)。 */}
                      {r.output ? <span className="meta">{r.output.slice(0, 400)}</span> : null}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {!sched || !sched.available ? (
            <div className="empty">{t("schedUnavailable")}</div>
          ) : sched.sessions.length === 0 ? (
            <div className="empty">{t("schedEmpty")}</div>
          ) : (
            <>
              <h3>{t("schedTitle")}</h3>
              <div className="list">
                {sched.sessions.map((s) => (
                  <div className="row" key={s.session}>
                    <span
                      className={
                        "badge " + (s.lastOutcome === "injected" ? "confirmed" : "rejected")
                      }
                    >
                      {s.lastMode ?? s.lastOutcome}
                    </span>
                    <span className="content">
                      {s.project ?? "-"} · {s.session.slice(0, 12)}
                    </span>
                    <span className="meta">
                      {t("schedSteps")} {s.steps} · {t("schedInjected")} {s.injected} ·{" "}
                      {t("schedSkipped")} {s.skipped} · {t("schedTokens")} {s.tokens} ·{" "}
                      {stamp(s.lastAt)}
                    </span>
                    <span className="meta">{s.lastReason}</span>
                  </div>
                ))}
              </div>
              <h3>{t("schedRecords")}</h3>
              <div className="list">
                {sched.records.map((r, i) => (
                  <div className="row" key={r.session + ":" + String(r.step) + ":" + String(i)}>
                    <span className={"badge " + (r.outcome === "injected" ? "confirmed" : "soft")}>
                      {r.mode ?? r.channel}
                    </span>
                    <span className="content">
                      {r.outcome} · step {r.step}
                      {r.ids.length ? " · " + r.ids.join(", ") : ""}
                    </span>
                    <span className="meta">
                      {r.tokens ? t("schedTokens") + " " + r.tokens + " · " : ""}
                      {t("schedDrift")} {r.topicDrift.toFixed(2)} · {stamp(r.at)}
                    </span>
                    <span className="meta">{r.reason}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </section>
      ) : tab === "cost" ? (
        <section className="pane">
          <div className="status-head">
            <span className="status-title">{t("captureTitle")}</span>
            {cost?.available ? (
              <span className="badge soft">
                {t("captureSize", {
                  files: String(cost.size.files),
                  records: String(cost.size.records),
                })}
              </span>
            ) : null}
            <button type="button" className="ghost" onClick={() => void refreshCost()}>
              {t("schedRefresh")}
            </button>
          </div>
          <p className="hint">{t("captureHint")}</p>
          {!cost || !cost.available ? (
            <div className="empty">{t("captureUnavailable")}</div>
          ) : cost.size.records === 0 ? (
            <div className="empty">{t("captureEmpty")}</div>
          ) : (
            <>
              {/* 分位数在前, 明细在后: 长尾现象看平均值会被大量正常轮次稀释掉 (见 capture-log.ts)。 */}
              <div className="status-head">
                <span className="badge confirmed">
                  {t("captureP50")} {cost.stats.totalMs.p50}ms
                </span>
                <span className="badge soft">
                  {t("captureP95")} {cost.stats.totalMs.p95}ms
                </span>
                <span className="badge soft">
                  {t("captureMax")} {cost.stats.totalMs.max}ms
                </span>
                <span className="meta">{t("captureCount", { n: String(cost.stats.count) })}</span>
                <span className="meta">
                  {t("captureSkipCount", { n: String(cost.stats.skipped) })}
                </span>
                {cost.stats.errors > 0 ? (
                  <span className="badge rejected">
                    {t("captureErrCount", { n: String(cost.stats.errors) })}
                  </span>
                ) : null}
              </div>
              <p className="hint">
                {t("captureMeanPhases", {
                  e: String(cost.stats.mean.episodeMs),
                  n: String(cost.stats.mean.enrichMs),
                  l: String(cost.stats.mean.linkMs),
                  s: String(cost.stats.mean.storeMs),
                })}
              </p>
              {cost.stats.slowest ? (
                <p className="hint">
                  {t("captureSlowest")}: {cost.stats.slowest.session.slice(0, 12)} · turn{" "}
                  {cost.stats.slowest.turn} · {cost.stats.slowest.totalMs}ms
                </p>
              ) : null}
              <h3>{t("captureRecords")}</h3>
              <div className="list">
                {cost.records.map((r, i) => (
                  <div className="row" key={r.session + ":" + String(r.turn) + ":" + String(i)}>
                    <span
                      className={
                        "badge " + (r.outcome === "stored" ? "confirmed" : r.outcome === "error" ? "rejected" : "soft")
                      }
                    >
                      {r.outcome === "stored"
                        ? t("captureOutcomeStored")
                        : r.outcome === "error"
                          ? t("captureSkipError")
                          : skipLabel(r.skip, t)}
                    </span>
                    <span className="content">
                      {(r.project ?? "-") + " · turn " + r.turn}
                      {r.skip && r.outcome === "skipped" ? " · " + skipLabel(r.skip, t) : ""}
                    </span>
                    <span className="meta">
                      {r.episodeMs}/{r.enrichMs}/{r.linkMs}/{r.storeMs} ms · 计 {r.totalMs}ms ·{" "}
                      {r.qChars}+{r.aChars} 字 · {stamp(r.at)}
                    </span>
                    {r.detail ? <span className="meta">{r.detail.slice(0, 200)}</span> : null}
                  </div>
                ))}
              </div>
            </>
          )}
        </section>
      ) : tab === "flagged" ? (
        <section className="pane">
          <h3>{t("flaggedTitle")}</h3>
          {flagged.length === 0 ? (
            <div className="empty">{t("flaggedEmpty")}</div>
          ) : (
            <div className="list">
              {flagged.map((v) => (
                <div className="row" key={v.id}>
                  <span className="badge rejected">
                    {t("flaggedBad")} {v.irrelevant + v.wrong}
                  </span>
                  <span className="content">{v.content}</span>
                  <span className="meta">
                    [{v.kind}] {v.id} · {t("flaggedExposure")} {v.exposure} · {t("flaggedQuality")}{" "}
                    {v.quality.toFixed(2)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>
      ) : null}

      {tab === "review" ? (
        <section className="panel">
          <h3>{t("tabCaptureReview")}</h3>
          {captureReview === null ? (
            <div className="meta">{t("loading")}</div>
          ) : !captureReview.available ? (
            <div className="banner info">{t("captureReviewUnavailable")}</div>
          ) : captureReview.items.length === 0 ? (
            <div className="empty">{t("captureReviewEmpty")}</div>
          ) : (
            <div className="list">
              {captureReview.items.map((r) => (
                <div className="row" key={r.id}>
                  <span className="badge soft">{r.project ?? r.session.slice(0, 12)}</span>
                  <span className="rule-text">{r.question || r.conclusion}</span>
                  <span className="meta">
                    {stamp(r.at)}
                    {r.conclusion ? " · 结论: " + r.conclusion.slice(0, 60) : ""}
                  </span>
                  {/* 原因必须展示: 审核机制的立身之本就是"人能看懂它为什么被标记" */}
                  {r.reasons.length ? (
                    <div className="meta">
                      {t("captureReviewWhy")}:
                      {r.reasons.map((why, i) => (
                        <div key={i}>· {why}</div>
                      ))}
                    </div>
                  ) : null}
                  {r.answerExcerpt ? (
                    <div className="meta">回答节选: {r.answerExcerpt.slice(0, 160)}</div>
                  ) : null}
                  {/* 处置按钮: 只给"看"不给"做"的队列是半成品 —— 人看懂了原因却无法动作。 */}
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => void resolveReview(r.id, "keep")}
                    title={t("captureReviewAccept")}
                  >
                    {t("captureReviewAccept")}
                  </button>
                  <button
                    type="button"
                    className="danger"
                    onClick={() => void resolveReview(r.id, "drop")}
                    title={t("captureReviewReject")}
                  >
                    {t("captureReviewReject")}
                  </button>
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
                  <span className={"badge soft " + scopeClass(r.scope)}>
                    {r.project ?? r.scope}
                  </span>
                  <span className="rule-text">{r.content}</span>
                  <span className="meta">
                    {stamp(r.assertedAt)}
                    {r.tags?.length ? " · #" + r.tags.join(" #") : ""}
                  </span>
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => void toggleEvidence(r.id)}
                    title={t("evidenceOpen")}
                  >
                    {evidence[r.id] && evidence[r.id] !== "loading"
                      ? t("evidenceClose")
                      : t("evidenceOpen")}
                  </button>
                  <button
                    type="button"
                    className="danger"
                    onClick={() => void delRecent(r.id)}
                    title={t("recentDelete")}
                  >
                    {t("recentDelete")}
                  </button>
                  {evidence[r.id] === "loading" ? (
                    <div className="meta evidence">{t("evidenceLoading")}</div>
                  ) : null}
                  {evidence[r.id] === "error" ? (
                    <div className="meta evidence">{t("evidenceUnavailable")}</div>
                  ) : null}
                  {evidence[r.id] && evidence[r.id] !== "loading" && evidence[r.id] !== "error"
                    ? (() => {
                        const c = evidence[r.id] as EvidenceChainView;
                        return (
                          <div className="meta evidence">
                            <div>
                              {t("evidenceSource")}: {c.source} ·{" "}
                              {c.traceable ? t("evidenceYes") : t("evidenceNo")}
                            </div>
                            {c.reasons.map((why, i) => (
                              <div key={i}>· {why}</div>
                            ))}
                            {c.episodes.length === 0 ? null : (
                              <div>
                                <div className="meta">{t("evidenceRawTurns")}</div>
                                {c.episodes.map((ep) => (
                                  <div key={ep.id} className="meta">
                                    [{ep.role} turn={ep.turn} {stamp(ep.at)}] {ep.text}
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })()
                    : null}
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
              {queue.map((p) => {
                const detail = open[p.id];
                const covers = readCovers(p.covers);
                return (
                  <div className="prop" key={p.id}>
                    <div className="row">
                      <span className={"badge " + p.status}>{p.status}</span>
                      {/* 草稿必须显眼: 它的规则文本只是"该主题有 N 条实例"的提示,
                          直接点确认等于把一句占位文本变成跨项目规则。 */}
                      {p.drafted ? <span className="badge rejected">{t("draftBadge")}</span> : null}
                      <span className="rule-text">{p.rule}</span>
                      <span className="meta">
                        {t("covers", { n: String(covers.count) })} ·{" "}
                        {Math.round(p.confidence * 100)}%
                        {p.sourceRun ? " · " + t("source", { run: p.sourceRun }) : ""}
                        {p.generatedAt ? " · " + stamp(p.generatedAt) : ""}
                      </span>
                      <span className="row-actions">
                        <button
                          type="button"
                          className="ghost"
                          disabled={covers.legacy || covers.ids.length === 0}
                          title={covers.legacy ? t("staleHostShort") : ""}
                          onClick={() => void toggle(p)}
                        >
                          {detail ? t("collapse") : t("expand")}
                        </button>
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
                    {p.drafted ? <div className="banner warn">{t("draftWarn")}</div> : null}
                    {/* 旧宿主: 只有计数没有 id, 展开做不到。这是**部署状态** (宿主没重启),
                        必须说出真正原因 —— 否则用户只会看到按钮灰着, 然后以为功能坏了。 */}
                    {covers.legacy || staleHost ? (
                      <div className="banner warn">{t("staleHost")}</div>
                    ) : null}
                    {detail === "loading" ? <div className="empty small">{t("loading")}</div> : null}
                    {detail === "error" ? <div className="banner err">{t("expandFailed")}</div> : null}
                    {Array.isArray(detail) ? (
                      detail.length === 0 ? (
                        <div className="empty small">{t("coversEmpty")}</div>
                      ) : (
                        <div className="covers">
                          {detail.map((c) => (
                            <div className="cover" key={c.id}>
                              <span className={"badge " + kindClass(c.kind)}>{c.kind}</span>
                              <span className="cover-text">{c.content}</span>
                              <span className="meta">
                                {c.status !== "active" ? c.status + " · " : ""}
                                {c.project ?? c.scope} · {stamp(c.assertedAt)} · {c.id}
                              </span>
                            </div>
                          ))}
                        </div>
                      )
                    ) : null}
                  </div>
                );
              })}
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
