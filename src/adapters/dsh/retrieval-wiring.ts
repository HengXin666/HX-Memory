// adapters/dsh/retrieval-wiring.ts — DSH 插件的检索器 + Facade 组装 (2026-11-02 从 index.ts 拆出, verify-structure 400 行约束)。
// 行为与拆分前逐行相同; 只是把 apply() 里这一段搬成函数, index.ts 调用它。
import { HybridRetriever } from "../../retrieval/hybrid.js";
import { MemoryFacade } from "../../app/facade.js";
import { LexicalEmbedder } from "../../retrieval/embedding-lexical.js";
import { LinearVectorIndex } from "../../retrieval/vector.js";
import { ProjectedVectorIndex } from "../../retrieval/vector-projected.js";
import { embedderFromConfig } from "../../app/embedding-config.js";
import type { FileBackend } from "../../storage/file-store.js";
import type { GeneralizerService } from "../../generalize/service.ts";

export function wireRetrieval(
  store: FileBackend,
  root: string,
  settings: () => { autoEvolve: boolean },
): { retriever: HybridRetriever; facade: MemoryFacade; localEmbedder: LexicalEmbedder; generalizerHolder: { current?: GeneralizerService } } {
  // v2 检索器: 绑定注入 / 会话召回 / memory_search 三条路共用同一个检索语义
  // (能力自述来自存储引擎, 降级会写进 RetrievalResult.degraded)。
  // 向量通道: 配了 HX_MEMORY_EMBEDDING_BASE_URL/MODEL 就用真语义 (异步 + 投影),
  // 否则用本地零依赖哈希嵌入器 (同步, 零配置也能跑)。
  // 环境变量优先, 其次面板配置的 embedding 段 (app/embedding-config.ts)。
  const httpEmbedder = embedderFromConfig();
  const localEmbedder = new LexicalEmbedder();
  /**
   * 四层切面 (Surface / Application / Ports / Engines)
   * .agents/notes/implemented/architecture/2026-09-10-four-layer-seams.md
   */
  const retriever = new HybridRetriever(store, {
    vectorIndex: httpEmbedder
      ? new ProjectedVectorIndex({ embedder: httpEmbedder })
      : new LinearVectorIndex({ embedder: localEmbedder }),
  });
  // 推广服务实例在下方构造 (依赖 reviewDir 与模型); Facade 需要它的"人审提议"出口，
  // 但不需要在构造时就有  用一个持有器打破"组装顺序"这个隐式契约 (const, 只填空一次)。
  const generalizerHolder: { current?: GeneralizerService } = {};
  // 使用层唯一 API: DSH 的工具/召回都经由它, 与 MCP/CLI 共用同一套语义 (ADR-021)。
  const facade = new MemoryFacade(
    { store, retriever },
    // 语义兜底去重默认开启 (本地零依赖哈希袋); 自动演化 (取代/冲突) 由设置控制。
    // 传函数: 面板里改 autoEvolve 当轮生效 (不再需要重启)。
    { embedder: localEmbedder, autoEvolve: () => settings().autoEvolve },
  );
  facade.withIndexStatus(() => store.ftsStatus());
  // 治理出口延后接线 (generalizer 建在下方, 依赖 reviewDir 与模型) 
  // 坏评超标的记忆据此产出人审提议; 不接线则标注照常落盘, 只是不产生提议。
  facade.withGeneralizer({
    enqueueProposal: (input) => {
      const g = generalizerHolder.current;
      if (!g) throw new Error("hx-memory: generalizer not mounted yet");
      return g.enqueueProposal(input);
    },
  });
  return { retriever, facade, localEmbedder, generalizerHolder };
}
