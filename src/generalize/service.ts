// src/generalize/service.ts — 推广服务: 聚类 → (可选 LLM 抽象) → review 队列。
// 人工闸门铁律: 服务永不直接写 rule; 只产出 proposal 到 review 队列, 由人确认后
// confirm() 才落 rule (带确认记录 + generalizes 关联)。对应 ai-docs 007 方案 (a)。
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import type { MemoryEntry, GeneralizationProposal } from "../kernel/types.ts";
import type { FileBackend } from "../storage/file-store.ts";
import { clusterByTheme } from "./cluster.ts";

/** LLM 抽象器端口 — 默认 null (无网络环境用启发式); adapter 注入真实实现。 */
export interface Abstractor {
  abstract(cluster: { theme: string; contents: string[]; sources: string[] }): Promise<{
    rule: string;
    confidence: number;
  }>;
}

export type ProposalStatus = "proposed" | "confirmed" | "rejected";

export interface QueuedProposal {
  id: string;
  status: ProposalStatus;
  proposal: GeneralizationProposal;
  sourceRun: string;
}

export class GeneralizerService {
  constructor(
    private readonly store: FileBackend,
    private readonly reviewDir: string,
    private readonly abstractor?: Abstractor,
  ) {}

  private heuristicRule(cluster: { theme: string; contents: string[] }): {
    rule: string;
    confidence: number;
  } {
    const texts = cluster.contents;
    if (texts.length === 1) return { rule: texts[0]!, confidence: 0.4 };
    const distinct = new Set(texts);
    const confidence = Math.min(0.9, 0.5 + distinct.size * 0.1);
    return {
      rule: `经验: ${cluster.theme} 相关的 ${distinct.size} 条实例已沉淀, 建议复核提炼为跨项目规则`,
      confidence,
    };
  }

  /** 批量推广: 候选条目 → 聚类 → 每簇产 proposal → 落 review 队列 (不入记忆)。 */
  async runBatch(sourceRun: string, candidates: MemoryEntry[]): Promise<QueuedProposal[]> {
    const clusters = clusterByTheme(candidates);
    const created: QueuedProposal[] = [];
    for (const c of clusters) {
      const abstracted = this.abstractor
        ? await this.abstractor.abstract({
            theme: c.theme,
            contents: c.entries.map((e) => e.content),
            sources: c.entries.map((e) => e.source),
          })
        : this.heuristicRule({ theme: c.theme, contents: c.entries.map((e) => e.content) });
      const proposal: QueuedProposal = {
        id: "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        status: "proposed",
        sourceRun,
        proposal: {
          rule: abstracted.rule,
          covers: c.entries.map((e) => e.id),
          confidence: abstracted.confidence,
          suggestedAction: "confirm",
          generatedAt: new Date().toISOString(),
        },
      };
      created.push(proposal);
      this.appendToQueue(proposal);
    }
    return created;
  }

  listQueue(status?: ProposalStatus): QueuedProposal[] {
    const file = this.queueFile();
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as QueuedProposal)
      .filter((p) => (status ? p.status === status : true));
  }

  /** 人工确认: proposal → rule (带确认记录 + generalizes 关联)。幂等。 */
  confirm(id: string, by: string): { ok: boolean; ruleId?: string; error?: string } {
    const item = this.listQueue().find((p) => p.id === id);
    if (!item || item.status !== "proposed")
      return { ok: false, error: "proposal not found or not proposed" };
    const now = new Date().toISOString();
    const coverEntries = item.proposal.covers
      .map((cid) => this.store.get(cid))
      .filter((e): e is MemoryEntry => e !== null);
    const ruleEntry: MemoryEntry = {
      id: "r" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      kind: "rule",
      content: item.proposal.rule,
      source: "generalizer:" + item.sourceRun,
      scope: "global",
      ts: { validAt: now, assertedAt: now },
      relations: coverEntries.map((e) => ({ type: "generalizes", toId: e.id })),
      confirmedBy: by,
      confirmedAt: now,
    };
    this.store.add(ruleEntry);
    this.setStatus(id, "confirmed");
    return { ok: true, ruleId: ruleEntry.id };
  }

  reject(id: string): void {
    this.setStatus(id, "rejected");
  }

  private queueFile(): string {
    return this.reviewDir + "/queue.jsonl";
  }

  private appendToQueue(p: QueuedProposal): void {
    mkdirSync(this.reviewDir, { recursive: true });
    appendFileSync(this.queueFile(), JSON.stringify(p) + "\n", "utf8");
  }

  private setStatus(id: string, status: ProposalStatus): void {
    const file = this.queueFile();
    if (!existsSync(file)) return;
    const out = readFileSync(file, "utf8")
      .split("\n")
      .map((l) => {
        if (!l.trim()) return l;
        const p = JSON.parse(l) as QueuedProposal;
        return p.id === id ? JSON.stringify({ ...p, status }) : l;
      });
    writeFileSync(file, out.join("\n"), "utf8");
  }
}
