// kernel/types.ts — domain types only. This module MUST NOT import any
// harness (DSH/Codex) or storage driver. Violations are architecture bugs.

export type MemoryKind =
  "fact" | "preference" | "event" | "decision" | "lesson" | "rule" | "pattern" | "context";

export type MemoryStatus = "active" | "superseded" | "shadow";

export type MemoryScope = "project" | "agent" | "global";

export type RelationType =
  "relates" | "supersedes" | "supersededBy" | "generalizes" | "appliesTo" | "source";

/** Relation always carries a direction (from → to). */
export interface Relation {
  type: RelationType;
  toId: string;
  weight?: number;
}

export interface Timestamps {
  /** When the fact is valid (temporal validity). */
  validAt: string;
  /** When the record was asserted (write time). */
  assertedAt: string;
}

export interface MemoryEntry {
  id: string;
  kind: MemoryKind;
  content: string;
  /** Provenance: session id / file path / URL. Every entry must be auditable. */
  source: string;
  scope: MemoryScope;
  /** Owning project name when scope:project; absent for agent/global. */
  project?: string;
  ts: Timestamps;
  status?: MemoryStatus;
  relations?: Relation[];
  /** Confirmation record for kind:"rule" (human gate). Machine proposals must NOT set this. */
  confirmedBy?: string;
  confirmedAt?: string;
  /** AI 结构化标签 (进入 SQLite tags 索引, 支持按 tag 召回)。可选: 启发式/未结构化时缺省。 */
  tags?: string[];
  /** AI 结构化摘要 (可选增强, 不替代原文; truth-in-files 仍以 content 为准)。 */
  structured?: { summary: string; points: string[] };
}

export interface Query {
  text?: string;
  kind?: MemoryKind;
  scope?: MemoryScope;
  tag?: string;
  /** Slice at a validity instant; answers "what was true at T". */
  at?: string;
  /** Filter by owning project (only meaningful with scope:project). */
  project?: string;
  limit?: number;
  minScore?: number;
}

export interface GeneralizationProposal {
  /** Candidate global rule text. */
  rule: string;
  /** Concrete instances this rule was abstracted from. */
  covers: string[];
  confidence: number;
  suggestedAction: "confirm" | "rewrite" | "reject";
  generatedAt: string;
}
