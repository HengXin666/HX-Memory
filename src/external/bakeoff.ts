// external/bakeoff.ts — 硬门槛过了之后才比较。过不了的引擎不能当默认。

export interface EngineProfile {
  id: string;
  kind: "memory" | "knowledge";
  license: string;
  /** 记忆引擎: 有没有原生 reflect。知识库引擎恒为 false。 */
  nativeReflect: boolean;
  /** 知识库: 能不能把图片当附件索引。 */
  images: boolean;
  /** 越小越轻。只在硬门槛都通过时参与排序。 */
  opsWeight: number;
  why: string;
}

/**
 * 四个还在维护、许可可随仓库分发的实现。
 * 排序依据写在 recommend(): 记忆优先原生反思, 知识库优先能收图片。
 */
export const ENGINE_PROFILES: readonly EngineProfile[] = [
  {
    id: "hindsight",
    kind: "memory",
    license: "MIT",
    nativeReflect: true,
    images: false,
    opsWeight: 3,
    why: "bank 隔离, retain/recall/reflect 对齐端口, 实体图做关联记忆",
  },
  {
    id: "mem0",
    kind: "memory",
    license: "Apache-2.0",
    nativeReflect: false,
    images: false,
    opsWeight: 1,
    why: "单容器 OSS, user_id 隔离; 没有 reflect, 由宿主补",
  },
  {
    id: "ragflow",
    kind: "knowledge",
    license: "Apache-2.0",
    nativeReflect: false,
    images: true,
    opsWeight: 4,
    why: "DeepDoc 覆盖 markdown、图片、pdf、ppt、html",
  },
  {
    id: "lightrag",
    kind: "knowledge",
    license: "MIT",
    nativeReflect: false,
    images: false,
    opsWeight: 2,
    why: "markdown 图检索更轻; 一个进程只服务一个 corpus",
  },
];

export const DEFAULT_MEMORY_ENGINE = "hindsight";
export const DEFAULT_KNOWLEDGE_ENGINE = "ragflow";

export interface BakeRow {
  id: string;
  /** 隔离、失效过滤、canonical id 往返。不过线就淘汰。 */
  hardPass: boolean;
}

/** 记忆: 原生 reflect 优先, 其次更轻。知识库: 图片优先, 其次更轻。 */
export function recommend(rows: readonly BakeRow[]): { memory: string; knowledge: string } {
  const byId = new Map(ENGINE_PROFILES.map((profile) => [profile.id, profile]));
  const memory = pick(rows, byId, "memory", (profile) => (profile.nativeReflect ? 0 : 1));
  const knowledge = pick(rows, byId, "knowledge", (profile) => (profile.images ? 0 : 1));
  return { memory, knowledge };
}

function pick(
  rows: readonly BakeRow[],
  byId: Map<string, EngineProfile>,
  kind: EngineProfile["kind"],
  primary: (profile: EngineProfile) => number,
): string {
  const ranked = rows
    .map((row) => ({ row, profile: byId.get(row.id) }))
    .filter((item): item is { row: BakeRow; profile: EngineProfile } => item.profile?.kind === kind && item.row.hardPass)
    .sort((a, b) => primary(a.profile) - primary(b.profile) || a.profile.opsWeight - b.profile.opsWeight);
  const winner = ranked[0];
  if (!winner) throw new Error("没有 " + kind + " 引擎通过硬门槛");
  return winner.profile.id;
}
