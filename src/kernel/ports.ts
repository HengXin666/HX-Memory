// kernel/ports.ts — the Port interfaces. The kernel depends only on these.
// Implementation decisions (which harness, which storage) live in adapters/ + storage/.
import type { GeneralizationProposal, MemoryEntry, Query } from "./types.js";

export interface MemoryStore {
  add(entry: MemoryEntry): Promise<void>;
  get(id: string): Promise<MemoryEntry | null>;
  query(q: Query): Promise<MemoryEntry[]>;
  /** Walk relations from an entry (e.g. supersedes chain expansion). */
  traverse(fromId: string, relationType: string): Promise<MemoryEntry[]>;
  update(id: string, patch: Partial<MemoryEntry>): Promise<void>;
}

export interface Capture {
  raw: string;
  at: string;
  project?: string;
}

export interface Recall {
  entries: MemoryEntry[];
  /** Advisory token budget hint for the harness injection point. */
  maxTokens?: number;
}

export interface SessionContext {
  id: string;
  project?: string;
  origin?: string; // "root" | "subagent" | ...
  header?: Record<string, unknown>;
}

export interface TurnData {
  text: string;
  at: string;
  role: "user" | "assistant";
}

export interface HarnessAdapter {
  readonly name: "dsh" | "codex" | "cli";
  /** What to inject at session start (guidance, not history). */
  onSessionStart(ctx: SessionContext): Promise<unknown>;
  /** Capture a finished turn into memory. */
  onTurnEnd(turn: TurnData): Promise<Capture[]>;
  /** Optional lightweight recall before a step. Return null to inject nothing. */
  onPreStep(step: { text: string; at: string }): Promise<Recall | null>;
  registerTools(registry: { define(name: string, fn: unknown): void }): void;
}

export interface Generalizer {
  /** Batch-abstract concrete lessons into a candidate rule (never auto-confirm). */
  generalize(entries: MemoryEntry[]): Promise<GeneralizationProposal>;
}
