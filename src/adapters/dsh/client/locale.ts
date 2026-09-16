// src/adapters/dsh/client/locale.ts — review / bindings 面板文案。
//
// 约定: 两个字典的键必须完全一致 —— bindingZh/reviewZh 显式标注为
// typeof bindingEn / typeof reviewEn, 少一个键就是编译错误, 不会漏到运行时
// 变成界面上的一条英文/空字符串。

export type Locale = typeof reviewEn;
export type BindingLocale = typeof bindingEn;
/** 设置卡字典与主字典分开: 卡片的文案只在宿主「插件」页里用, 不该混进审阅页的键空间。 */
export type CardLocale = typeof cardEn;

export const cardEn = {
  title: "Memory injection",
  desc: "When the standing memory entries (cross-project rules, key facts) enter the conversation. Once injected, the block stays in context — re-sending it every turn only repeats the same entries and spends budget.",
  modeFirst: "First turn only",
  modeEveryTurn: "Every turn (delta)",
  modeFirstHint:
    "Injects once at the start of the session, then stays silent. Later turns can still call memory_search on demand — the tool is always available.",
  modeEveryTurnHint:
    "Injects on every turn, but only entries not already in this session's context (a delta). Recalled history for a mid-session question still arrives automatically.",
  saved: "Saved",
  saveFailed: "Save failed:",
};

export const bindingEn = {
  nav: "Memory Bindings",
  title: "Memory Bindings (VCP-style topology)",
  desc: "Declare which memory sources each project binds. Bound sources are injected deterministically at each pre-step — no model discretion.",
  projectHint:
    "Project key = the session working directory's folder name (e.g. /code/api → api). Bindings without signal words inject on every step; with signal words they inject only when the latest user text matches.",
  noProjects: "No bindings yet. Add a project to declare its memory sources.",
  addProject: "Add project",
  projectPh: "project name",
  bindingId: "source id (e.g. cross-rules)",
  kind: "kind",
  scope: "scope",
  projectFilter: "filter project",
  signalWords: "signal words (comma separated, empty = always)",
  weight: "weight",
  max: "max",
  addBinding: "Add binding",
  save: "Save all",
  saved: "Saved",
  saveFailed: "Save failed",
  remove: "remove",
  any: "(any)",

  // 一键模板 (presets): 免填 6 个字段的主路径。
  presets: "One-click templates",
  presetHint: "Each template appends a ready-made binding to {project}.",
  presetUntitled: "(untitled project)",
  presetCrossRules: "Cross-project rules",
  presetProjectLessons: "This project's lessons",
  presetSharedAgent: "Shared across workspaces",
  presetLessonsDecisions: "Lessons and decisions",
  presetAdded: "Added template: {name}",
  presetDupe: "{name} is already bound to {project}",

  // 当前项目 (从宿主会话 cwd 派生) 的自动行。
  currentProjectTag: "current",
  currentProjectHint: "This row is pre-filled from the session working directory.",

  // 高级模式: 默认只留 id/kind/scope/信号词。
  advanced: "Advanced",
  advancedHint: "Shows weight, max and the project filter.",

  // 结构与状态。
  twoStepHint:
    "No project yet? Pick a template below — the current project row is created for you.",
  bindingsCount: "{n} source(s)",
  noBindings: "No sources bound yet — pick a template above.",
  removeProject: "Remove project",
  saveHint: "Save writes every project's list at once.",
  dirty: "Unsaved edits — auto-refresh is paused.",
  loading: "Loading…",
};

export const reviewEn = {
  nav: "HX-Memory Review",
  title: "HX-Memory Review Queue",
  desc: "Confirm or reject generalization proposals. Confirmed proposals become cross-project rules.",
  queue: "Proposals",
  empty: "No pending proposals. Run a generalization batch to surface lessons here.",
  runBatch: "Run generalization batch",
  running: "Running…",
  batchDone: "batch done: {n} proposal(s)",
  covers: "covers {n} instance(s)",
  // 人审展开: 提议只给一句抽象规则, 判断依据是它概括的原文 —— 必须能就地看到。
  expand: "Show sources",
  collapse: "Hide sources",
  coversEmpty: "The covered entries are no longer in the store (withdrawn or rebuilt).",
  expandFailed: "Could not load the covered entries (see the error above).",
  // 宿主比面板旧 (只重建了插件产物, 没重启宿主): 展开做不到, 且必须说清是哪一侧旧。
  staleHostShort: "Restart the host to show the sources",
  staleHost:
    "This panel is newer than the running host: the host returned a source count instead of entry ids, so the sources cannot be shown. Restart the host (its process loaded the plugin before the last build) — no data is lost.",
  // 启发式占位草稿: 没有 AI 提炼时它只是"该主题有 N 条实例"的提示, 不能当作规则确认。
  draftBadge: "draft",
  draftWarn:
    "This is a heuristic placeholder draft (no AI abstraction for this cluster): the text only says how many instances share a theme. Rewrite it into a real rule before confirming.",
  confirm: "Confirm as rule",
  reject: "Reject",
  confirmed: "confirmed",
  rejected: "rejected",
  source: "source: {run}",
  browse: "Memory Browse",
  search: "Search memory...",
  tabProposals: "Proposals",
  tabRecent: "Recently captured",
  tabInvocations: "AI invocations",
  tabFlagged: "Flagged",
  flaggedEmpty:
    "No memories flagged by the agent yet. Empty here is the good case - the agent only flags memories that were clearly irrelevant or factually wrong.",
  flaggedTitle:
    "Memories the agent flagged as bad (flags lower ranking weight; content problems enter the human review queue)",
  flaggedBad: "bad",
  flaggedExposure: "exposure",
  flaggedQuality: "quality",

  // 注入调度账本 ("为什么这一轮注入/没注入")。
  tabSchedule: "Injection schedule",
  tabCaptureCost: "Capture cost",
  schedHint:
    "Why every turn got memory - or did not. One record per pre-step, written to <root>/schedule/*.jsonl; records that injected nothing are kept on purpose.",
  schedUnavailable:
    "This host has no schedule log mounted (older adapter, or the log is switched off).",
  schedEmpty: "No pre-step has been recorded yet. Records appear as soon as a session injects.",
  schedTitle: "Sessions (most recent first)",
  schedRecords: "Recent records",
  schedSteps: "steps",
  schedInjected: "injected",
  schedSkipped: "no-op",
  schedTokens: "≈tokens",
  schedSize: "{files} file(s) · {records} record(s) on disk",
  schedDrift: "drift",
  schedReason: "why",
  schedRefresh: "Refresh",
  maintTitle: "Background maintenance (P3 scheduler)",
  maintHint:
    "Runs only during idle windows (never while truth files are being written); records live in memory and reset on restart. Interval 0 disables it. Settings: hx-memory.maintenanceIntervalHours / maintenanceIdleMinutes on the host settings page (no restart needed).",
  maintOn: "Enabled · every {h}h",
  maintOff: "Disabled (interval 0)",
  maintNoCli: "No runnable CLI found",
  maintIdle: "idle threshold {m} min",
  maintEmpty: "Not run yet (or the idle condition was never met)",
  maintOk: "ok",
  maintFailed: "failed",
  maintTook: "{ms}ms",
  maintUnavailable: "This host has no maintenance records",

  // 捕获耗时账本 ("沉淀花了多久 / 为什么没沉淀")。与注入调度是两条不同的轴。
  captureTitle: "Capture cost (this is where the sink spends its time)",
  captureHint:
    "Every completed turn writes one record to <root>/capture/*.jsonl. Capture is async for the host, but it shares the process with your conversation - so this is the number to read when a turn feels slower than usual. Note: totalMs is the cost capture adds AFTER turn/end; it is not your end-to-end turn latency (the host exposes no such number).",
  captureUnavailable:
    "This host has no capture log mounted (older adapter, or the log is switched off).",
  captureEmpty: "No completed turn has been recorded yet.",
  captureSize: "{files} file(s) · {records} record(s) on disk",
  captureCount: "{n} timed turn(s)",
  captureSkipCount: "{n} skipped",
  captureErrCount: "{n} error(s)",
  captureP50: "p50",
  captureP95: "p95",
  captureMax: "max",
  captureMeanPhases: "mean per phase: episode {e}ms · enrich {n}ms · links {l}ms · store {s}ms",
  captureSlowest: "slowest turn",
  captureRecords: "Recent turns (newest first)",
  captureOutcomeStored: "stored",
  captureSkipDisabled: "capture off",
  captureSkipSubagent: "subagent",
  captureSkipNoTurn: "no turn",
  captureSkipNoSignal: "no signal",
  captureSkipNoConclusion: "no conclusion",
  captureSkipError: "error",

  recentEmpty:
    "Nothing captured yet. It fills automatically as you talk (pitfalls, decisions, preferences).",
  recentKeep: "Keep",
  recentDelete: "Delete",
  deleted: "deleted",
  recentTitle: "Recently captured (auto-sink, you keep the right to review)",
  invEmpty: "No AI invocations yet. They appear when a memory is structured or abstracted.",
  invTask: "task",
  invPrompt: "prompt",
  invInput: "input",
  invOutput: "output",
  invOk: "ok",
  invFail: "fail",

  // 批次状态栏 (generalizationStatus 轮询)。
  statusTitle: "Batch status",
  statusRefresh: "Refresh",
  statusNever: "No batch has run yet.",
  statusAt: "last run {at}",
  statusConsidered: "considered",
  statusClusters: "clusters",
  statusProposed: "proposed",
  statusSkipped: "covered-skip",
  statusMs: "ms",
  statusUsedLlm: "LLM abstraction",
  statusRuleOnly: "rule match only",
  abstractorOn: "AI abstraction: ON",
  abstractorOff: "AI abstraction: OFF",
  abstractorOffWarn:
    "No AI abstractor is attached: a batch can only emit draft rules that you must rewrite by hand. Expect weak results until one is configured.",
  statusError: "Last run failed: {error}",
  statusUnavailable: "Status unavailable: {error}",
  queueProposed: "pending",
  queueConfirmed: "confirmed",
  queueRejected: "rejected",

  // 运行中 / 批次报告。
  runningLive: "Running… {n}s",
  reportTitle: "Last batch report",
  reportFailed: "Batch failed: {error}",

  // 记忆浏览 (相关度排序, 规则不再霸榜)。
  rank: "#{n}",
  browseHint:
    "Relevance-ranked: the closest match first. Nothing unrelated is padded in, and confirmed rules appear only when they are relevant.",
  browseEmpty: "No relevant memory found. That is a normal result — try other words.",
  searchBtn: "Search",
  proposalsCount: "{n} pending",
  loading: "Loading…",
};

export const bindingZh: BindingLocale = {
  nav: "记忆绑定",
  title: "记忆绑定 (VCP 式记忆拓扑)",
  desc: "声明每个项目绑定哪些记忆源。绑定源在每个 pre-step 确定性注入 — 不依赖模型自觉调工具。",
  projectHint:
    "项目键 = 会话工作目录的目录名 (如 /code/api → api)。无信号词的绑定每步都注入; 有信号词的绑定只在最新用户文本命中时注入。",
  noProjects: "还没有绑定。添加一个项目来声明它的记忆源。",
  addProject: "添加项目",
  projectPh: "项目名",
  bindingId: "绑定名 (如 cross-rules)",
  kind: "类型",
  scope: "范围",
  projectFilter: "项目过滤",
  signalWords: "信号词 (逗号分隔, 留空=总是注入)",
  weight: "权重",
  max: "上限",
  addBinding: "加绑定",
  save: "保存全部",
  saved: "已保存",
  saveFailed: "保存失败",
  remove: "移除",
  any: "(任意)",

  presets: "一键模板",
  presetHint: "点一下就把现成的绑定加到 {project}。",
  presetUntitled: "(未命名项目)",
  presetCrossRules: "跨项目规则",
  presetProjectLessons: "本项目经验",
  presetSharedAgent: "跨工作区共享",
  presetLessonsDecisions: "只看教训与决策",
  presetAdded: "已添加模板: {name}",
  presetDupe: "{project} 里已经有 {name} 了",

  currentProjectTag: "当前",
  currentProjectHint: "这一行由会话工作目录自动带出。",

  advanced: "高级",
  advancedHint: "展开权重 / 上限 / 项目过滤。",

  twoStepHint: "还没有项目? 直接点下面的模板, 当前项目这一行会自动建好。",
  bindingsCount: "{n} 个绑定",
  noBindings: "还没有绑定源 — 点上面的模板即可。",
  removeProject: "移除项目",
  saveHint: "保存会一次性写入所有项目。",
  dirty: "有未保存改动 — 自动刷新已暂停。",
  loading: "读取中…",
};

export const reviewZh: Locale = {
  nav: "HX-Memory 审阅",
  title: "HX-Memory 推广审阅队列",
  desc: "确认或驳回推广提议。确认后提议成为跨项目规则。",
  queue: "待审提议",
  empty: "暂无待审提议。点上面的按钮跑一次推广批次, 经验教训会出现在这里。",
  runBatch: "运行推广批次",
  running: "运行中…",
  batchDone: "批次完成: {n} 条提议",
  covers: "覆盖 {n} 条实例",
  // 人审展开: 提议只给一句抽象规则, 判断依据是它概括的原文 —— 必须能就地看到。
  expand: "看依据",
  collapse: "收起依据",
  coversEmpty: "它覆盖的条目已经不在库里了 (被撤回或重建过)。",
  expandFailed: "取不回被覆盖的条目 (见上方错误)。",
  // 宿主比面板旧 (只重建了插件产物, 没重启宿主): 展开做不到, 且必须说清是哪一侧旧。
  staleHostShort: "重启宿主后才能看依据",
  staleHost:
    "面板比正在运行的宿主新: 宿主返回的是「覆盖条数」而不是条目 id, 因此看不到依据。重启宿主即可 (它的进程在最近一次构建之前就已经把插件读进内存了) —— 数据没有任何丢失。",
  // 启发式占位草稿: 没有 AI 提炼时它只是"该主题有 N 条实例"的提示, 不能当作规则确认。
  draftBadge: "草稿",
  draftWarn:
    "这是启发式占位草稿 (这一簇没有走 AI 提炼): 文本只说「该主题有 N 条实例」, 不含可确认的内容。请先改写为真正的规则再确认。",
  confirm: "确认为规则",
  reject: "驳回",
  confirmed: "已确认",
  rejected: "已驳回",
  source: "来源: {run}",
  browse: "记忆浏览",
  search: "搜索记忆...",
  tabProposals: "推广提议",
  tabRecent: "新沉淀",
  tabInvocations: "调用记录",
  tabFlagged: "标注记录",
  flaggedEmpty:
    "还没有被 agent 标坏的记忆。这里**空着是好事** —— agent 只在记忆明显不相关或与事实不符时才会标注。",
  flaggedTitle: "被 agent 标注为有问题的记忆 (标注会降低排序权重, 内容问题会进入人审队列)",
  flaggedBad: "坏评",
  flaggedExposure: "曝光",
  flaggedQuality: "质量因子",

  tabSchedule: "注入调度",
  tabCaptureCost: "沉淀耗时",
  schedHint:
    "每一轮为什么拿到 / 没拿到记忆。每一步判定都落一条到 <root>/schedule/*.jsonl —— 没注入的那几种**故意留着**, 否则你只看得到成功的那些。",
  schedUnavailable: "当前宿主没有挂载调度账本 (适配器较旧, 或账本被关掉了)。",
  schedEmpty: "还没有预步判定记录。会话真正开始注入时就会写进来。",
  schedTitle: "会话 (最近的在前)",
  schedRecords: "最近记录",
  schedSteps: "判定次数",
  schedInjected: "注入",
  schedSkipped: "未注入",
  schedTokens: "约 token",
  schedSize: "磁盘上 {files} 个文件 · {records} 条记录",
  schedDrift: "漂移",
  schedReason: "原因",
  schedRefresh: "刷新",
  maintTitle: "后台维护 (P3 调度器)",
  maintHint:
    "只在空闲窗内跑 (避免与捕获并发改写真相文件); 结果是内存记录, 重启后清空。周期 0 即关闭。",
  maintOn: "已开启 · 每 {h} 小时",
  maintOff: "已关闭 (周期 0)",
  maintNoCli: "找不到可执行的 CLI",
  maintIdle: "空闲门槛 {m} 分钟",
  maintEmpty: "还没有跑过 (或从未满足空闲条件)",
  maintOk: "成功",
  maintFailed: "失败",
  maintTook: "{ms}ms",
  maintUnavailable: "本宿主没有维护记录",

  // 捕获耗时账本 ("沉淀花了多久 / 为什么没沉淀")。与注入调度是两条不同的轴。
  captureTitle: "沉淀成本 (它到底把时间花在哪)",
  captureHint:
    "每一轮完成的对话落一条到 <root>/capture/*.jsonl。捕获对宿主是异步的, 但它与你的对话同进程 —— 所以某一轮「比平时慢」时就该读这个数。注意 totalMs 记的是「捕获在 turn/end 之后又占用了多久」, 不是你的端到端轮次延迟 (宿主没有这个接口)。",
  captureUnavailable: "当前宿主没有挂载捕获耗时账本 (适配器较旧, 或账本被关掉了)。",
  captureEmpty: "还没有记录到任何完成的轮次。",
  captureSize: "磁盘上 {files} 个文件 · {records} 条记录",
  captureCount: "{n} 轮有耗时",
  captureSkipCount: "跳过 {n}",
  captureErrCount: "出错 {n}",
  captureP50: "p50",
  captureP95: "p95",
  captureMax: "最大",
  captureMeanPhases: "分段均值: episode {e}ms · 结构化 {n}ms · 建边 {l}ms · 落盘 {s}ms",
  captureSlowest: "最慢的一轮",
  captureRecords: "最近轮次 (新的在前)",
  captureOutcomeStored: "已沉淀",
  captureSkipDisabled: "捕获关着",
  captureSkipSubagent: "子 agent",
  captureSkipNoTurn: "没有形成问答",
  captureSkipNoSignal: "无信号",
  captureSkipNoConclusion: "读不出结论",
  captureSkipError: "出错",

  recentEmpty: "还没有自动沉淀。正常对话 (踩坑/决策/偏好) 会自动填到这里。",
  recentKeep: "保留",
  recentDelete: "删除",
  deleted: "已删除",
  recentTitle: "新沉淀 (自动捕获, 你有权随时查看/撤回)",
  invEmpty: "还没有 AI 调用记录。当记忆被结构化或提炼时会出现在这里。",
  invTask: "任务",
  invPrompt: "提示词",
  invInput: "输入",
  invOutput: "输出",
  invOk: "成功",
  invFail: "失败",

  statusTitle: "批次状态",
  statusRefresh: "刷新",
  statusNever: "还没跑过推广批次。",
  statusAt: "上次运行 {at}",
  statusConsidered: "考虑",
  statusClusters: "聚类",
  statusProposed: "提议",
  statusSkipped: "跳过已覆盖",
  statusMs: "毫秒",
  statusUsedLlm: "AI 提炼",
  statusRuleOnly: "仅规则匹配",
  abstractorOn: "AI 提炼: 开",
  abstractorOff: "AI 提炼: 关",
  abstractorOffWarn:
    "当前没有挂载 AI 提炼器: 批次只能产出草稿规则, 必须你手动重写, 效果会明显偏差。配置后才会好转。",
  statusError: "上次运行失败: {error}",
  statusUnavailable: "状态读取失败: {error}",
  queueProposed: "待审",
  queueConfirmed: "已确认",
  queueRejected: "已驳回",

  runningLive: "运行中… {n}s",
  reportTitle: "上次批次报告",
  reportFailed: "批次失败: {error}",

  rank: "第 {n} 位",
  browseHint:
    "按相关度排序: 最相关的排最前。不会拿不相关的内容凑数, 已确认的规则也只在相关时才出现。",
  browseEmpty: "没有找到相关记忆。这是正常结果, 可以换个词再搜。",
  searchBtn: "搜索",
  proposalsCount: "待审 {n} 条",
  loading: "读取中…",
};

export const cardZh: CardLocale = {
  title: "记忆注入",
  desc: "常驻记忆条目 (跨项目规则/关键事实) 什么时候进上下文。注入过的块会一直留在上下文里 —— 每轮再发一遍只是把同几条重复一遍, 还白烧预算。",
  modeFirst: "只在首轮注入",
  modeEveryTurn: "每轮注入 (差量)",
  modeFirstHint:
    "会话开始时注入一次, 之后不再自动注入。后续轮次仍可随时调用 memory_search 按需检索 —— 工具一直在。",
  modeEveryTurnHint:
    "每轮都注入, 但只补「本会话上下文里还没有的」条目 (差量)。会话中途的回忆型提问仍能自动拿到具体历史。",
  saved: "已保存",
  saveFailed: "保存失败:",
};
