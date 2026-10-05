// src/adapters/dsh/gateway-deps.ts — Gateway 的依赖面 (从 gateway.ts 拆出)。
//
// 为什么拆: gateway.ts 已按"投影拆到独立文件"的既有模式拆过三处
// (gateway-memory / gateway-observability / gateway-review), 都是因为它有 400 行上限。
// 本轮加入"注入预览"后再次触顶, 于是把**依赖面声明**也搬出来 ——
// 它本就是"契约"而不是"服务生命周期", 与端点实现混在一个类里会两头都难读。
import type { MemoryOperations } from "../../kernel/ports.ts";
import type { MemoryFacade } from "../../app/facade.ts";
import type { BindingStore } from "../../bindings/store.ts";
import type { GeneralizerService } from "../../generalize/service.ts";
import type { MemoryNormalizer } from "../../app/normalize.ts";
import type { CaptureReviewBridge } from "./capture-review-bridge.ts";
import type { AlwaysOnDetailedReader } from "./gateway-injection.ts";
import type { InvocationLog } from "./invocations.js";
import type { ScheduleLog } from "./schedule-log.js";
import type { CaptureLog } from "./capture-log.js";
import type { MaintenanceLog } from "./maintenance-log.js";

/** Gateway 依赖的最小端口 (可插拔: 便于测试注入, 也便于换实现)。 */
export interface HxMemoryGatewayDeps {
  /** 面板只需要端口能力 (含可选的 recent; 未实现时退回 query)。 */
  store: Pick<MemoryOperations, "query" | "get" | "remove" | "recent">;
  generalizer: Pick<
    GeneralizerService,
    "listQueue" | "confirm" | "reject" | "runBatch" | "runRecent" | "enqueueProposal" | "status"
  >;
  /** 绑定配置存储 (可选: 不注入则面板的绑定页不可用)。 */
  bindingStore?: BindingStore;
  /** AI 调用记录 (可选: 不注入则「调用记录」tab 不可用)。 */
  invocations?: InvocationLog;
  /**
   * 主动整理 / 无损迁移 (可选: 不注入则「整理」tab 不可用)。
   * 面板只做"看清单 + 点确认", 真正的写回在 MemoryNormalizer (与 CLI 同一条实现)。
   */
  normalizer?: Pick<MemoryNormalizer, "run">;
  /**
   * 使用层 Facade (可选但推荐): 面板的"最近沉淀/搜索/删除"与工具、MCP、CLI 共用同一套语义
   * (检索排序 + 治理闸门 + 可见性 + 审计)。不注入时退回直连存储的旧行为 (兼容测试/旧宿主)。
   */
  // 窄化的面: 只列面板真正用到的方法 (避免 gateway 与整个 Facade 耦合)。
  // evidenceChain 与 memory_evidence 工具共用同一个实现 —— 两侧口径必须一致。
  //
  // ⚠ **2026-10-05**: `remember` 已从这一面移出、`forget` 补进来 —— 审核语义反转为
  // "剔除已入库的记忆"后, 面板需要的是 forget 而不是再来一次 remember (见 gateway-memory.ts
  // 的 resolveCaptureReview 头注)。forget 本来就在这一面上 (deleteEntry 用它), 因此是净减一项。
  facade?: Pick<MemoryFacade, "recent" | "forget" | "recall" | "evidenceChain">;
  /**
   * 注入调度账本 (可选: 不注入则「调度」tab 明确说自己不可用, 而不是无声空白)。
   *
   * 为什么必须由服务端给: 账本是 <root>/schedule 下的文件, 浏览器侧 (面板) 碰不到文件系统。
   */
  schedule?: Pick<ScheduleLog, "sessions" | "recent" | "size">;
  /** 待审队列 (队列在 <root>/review-capture 下, 浏览器碰不到; 没出口就等于悄悄丢弃)。 */
  captureReview?: CaptureReviewBridge;
  /** always-on 的**带报告**读取器 (注入预览用; 类型定义在 gateway-injection.ts)。 */
  alwaysOnDetailed?: AlwaysOnDetailedReader;
  /**
   * 捕获耗时账本 (可选: 不注入则「捕获耗时」区块明确说自己不可用)。
   *
   * 与调度账本同一个理由必须由服务端给: 数据是 <root>/capture 下的文件, 浏览器侧碰不到。
   * 它与调度账本是**两条不同的轴**: 一个记"为什么注入/没注入", 一个记"沉淀花了多久、为什么没沉淀"。
   */
  capture?: Pick<CaptureLog, "stats" | "recent" | "size">;
  /**
   * 后台维护记录 (可选: 不注入则面板不显示维护区块)。
   *
   * 为什么必须由服务端给: 维护记录在插件进程的内存里 (环形缓冲), 浏览器侧拿不到。
   * 它是**内存**而不是文件 —— 与调度账本不同, 维护只回答"它最近有没有在工作",
   * 跨重启的历史不在它的职责内 (见 maintenance-log.ts 的取舍说明)。
   */
  maintenance?: Pick<MaintenanceLog, "recent" | "lastRun" | "size">;
  /** 维护开关与周期 (面板要显示"现在是开还是关", 而不是让人去猜设置)。 */
  maintenanceConfig?: () => {
    intervalMs: number;
    idleMs: number;
    available: boolean;
  };
  /**
   * 当前会话的项目键 (可选)。
   *
   * 为什么必须由服务端给: 面板跑在宿主 Web 里, 浏览器的 rpc 调用器**只有 call**, 拿不到
   * 会话工作目录; 面板此前试图读 `rpc.cwd` (不存在的字段) 于是自动建行永远不生效 ——
   * 这条能力只能是"知道会话的项目键"的一侧提供 (即 DSH 适配层)。
   */
  currentProject?: () => string | undefined;
  /**
   * 真相文件读取 (§795 文件视图): 列举/读取 `<root>/{daily,digest,rules}/*.md`。
   *
   * 为什么必须由服务端给: 与 schedule/capture 账本同一个理由 —— **浏览器侧碰不到文件系统**。
   * 而 ADR-002 的核心承诺就是"真相在文件", 人侧必须有入口直接看到它 (此前只能经 SQLite)。
   */
  truthFiles?: {
    root: string;
  };
}
