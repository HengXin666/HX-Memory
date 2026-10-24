// external/ports.ts — 引擎只看见投影接口。换库不改宿主, 也不改 canonical 字段。
import type { CanonicalDoc, CanonicalMemory } from "./canonical.ts";

export interface EngineHit {
  /** 必须是 canonical id。映射不出来的命中一律丢掉。 */
  canonicalId: string;
  score?: number;
}

export interface MemoryQuery {
  text: string;
  limit: number;
  kinds?: readonly CanonicalMemory["kind"][];
}

export interface ReflectRequest {
  question: string;
  context: string;
  disposition: string;
}

export interface Reflection {
  text: string;
  citations: string[];
  insufficient: boolean;
}

/**
 * 记忆引擎。reset + upsert 是迁移协议: 任何实现都必须能从 canonical 全量重建。
 */
export interface MemoryEngine {
  readonly id: string;
  readonly capabilities: { nativeReflect: boolean };
  reset(bankId: string): Promise<void>;
  upsert(bankId: string, records: readonly CanonicalMemory[]): Promise<void>;
  recall(bankId: string, query: MemoryQuery): Promise<EngineHit[]>;
  reflect?(bankId: string, input: ReflectRequest): Promise<Reflection>;
}

export interface KnowledgeQuery {
  text: string;
  limit: number;
}

export interface KnowledgeHit {
  docId: string;
  /** 引擎切出来的片段。文档身份以 docId 回 canonical 为准。 */
  text: string;
  score?: number;
}

/**
 * 知识库引擎。文档正文在 canonical; 这里只负责切块和召回。
 */
export interface KnowledgeEngine {
  readonly id: string;
  readonly capabilities: {
    markdown: boolean;
    images: boolean;
    pdf: boolean;
    ppt: boolean;
    html: boolean;
  };
  reset(corpusId: string): Promise<void>;
  upsert(corpusId: string, docs: readonly CanonicalDoc[]): Promise<void>;
  search(corpusId: string, query: KnowledgeQuery): Promise<KnowledgeHit[]>;
}

export class EngineError extends Error {
  readonly engine: string;
  readonly status: number;

  constructor(engine: string, status: number, detail: string) {
    super(engine + " HTTP " + status + ": " + detail);
    this.name = "EngineError";
    this.engine = engine;
    this.status = status;
  }
}
