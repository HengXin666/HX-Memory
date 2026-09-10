// src/generalize/service.ts — 推广服务: 聚类 → (可选 LLM 抽象) → review 队列。
// 人工闸门铁律: 服务永不直接写 rule; 只产出 proposal 到 review 队列, 由人确认后
// confirm() 才落 rule (带确认记录 + generalizes 关联)。对应 ai-docs 007 方案 (a)。
//
// 触发点 (2026-09 补齐): 面板按钮 (gateway.runGeneralization) / memory_rule_propose 工具
// → runRecent()/enqueueProposal(); 没有触发点时 review 队列永远是空的, 推广闭环是空转的。
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { MemoryEntry, GeneralizationProposal } from "../kernel/types.ts";
import type { ProposalStatus, QueuedProposal } from "../kernel/types.ts";
import type { Abstractor, Generalizer, MemoryStore } from "../kernel/ports.ts";
import { clusterByTheme } from "./cluster.ts";

export type { ProposalStatus, QueuedProposal };
export type { Abstractor };

/** 单条规则的长度上限: 过长的"规则"实际上不可执行, 也会污染注入上下文。 */
const MAX_RULE_LENGTH = 500;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

const PROPOSAL_STATUSES: readonly ProposalStatus[] = ["proposed", "confirmed", "rejected"];

/**
 * 逐行解析队列; 形状不完整返回 null (调用方决定跳过还是保留原文)。
 * 只校验"能安全使用"的字段: 缺 covers 会让 confirm 抛 TypeError, 缺 status 会让状态机失效。
 */
function parseProposalLine(line: string): QueuedProposal | null {
  try {
    const parsed = JSON.parse(line) as Partial<QueuedProposal> & {
      proposal?: Partial<GeneralizationProposal>;
    };
    if (!parsed || typeof parsed.id !== "string") return null;
    if (typeof parsed.proposal?.rule !== "string" || !parsed.proposal.rule.trim()) return null;
    if (!PROPOSAL_STATUSES.includes(parsed.status as ProposalStatus)) return null;
    const covers = Array.isArray(parsed.proposal.covers)
      ? parsed.proposal.covers.filter((c): c is string => typeof c === "string")
      : [];
    const confidence = Number(parsed.proposal.confidence);
    return {
      id: parsed.id,
      status: parsed.status as ProposalStatus,
      sourceRun: typeof parsed.sourceRun === "string" ? parsed.sourceRun : "unknown",
      proposal: {
        rule: parsed.proposal.rule,
        covers,
        confidence: Number.isFinite(confidence) ? confidence : 0.5,
        suggestedAction: parsed.proposal.suggestedAction ?? "confirm",
        generatedAt:
          typeof parsed.proposal.generatedAt === "string"
            ? parsed.proposal.generatedAt
            : new Date(0).toISOString(),
      },
    };
  } catch {
    return null;
  }
}

export interface GeneralizerOptions {
  /** 抽象失败时的旁路通知 (观测用; 不影响回退)。 */
  onAbstractError?: (error: unknown, cluster: { theme: string }) => void;
}

export class GeneralizerService implements Generalizer {
  // 显式字段 + 赋值 (不用 TS 参数属性): Node strip-only 模式不支持, 子进程 import 时会崩。
  private readonly store: MemoryStore;
  private readonly reviewDir: string;
  private readonly abstractor?: Abstractor;
  private readonly options: GeneralizerOptions;

  constructor(
    store: MemoryStore,
    reviewDir: string,
    abstractor?: Abstractor,
    options: GeneralizerOptions = {},
  ) {
    this.store = store;
    this.reviewDir = reviewDir;
    this.abstractor = abstractor;
    this.options = options;
  }

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

  /**
   * 抽象一簇: 有 LLM 抽象器时优先用, 失败/超时/无 agents 服务则回退启发式。
   * 回退必须发生在这里 —— 整批推广不能因为一次 AI 故障而失败。
   */
  private async abstractCluster(cluster: {
    theme: string;
    contents: string[];
    sources: string[];
  }): Promise<{ rule: string; confidence: number }> {
    if (this.abstractor) {
      try {
        const raw = await this.abstractor.abstract(cluster);
        const rule = typeof raw?.rule === "string" ? raw.rule.trim() : "";
        const confidence = Number(raw?.confidence);
        // 空规则 / NaN 置信度不能进队列: 一旦被人确认就会落成一条空 rule。
        if (!rule || rule.length > MAX_RULE_LENGTH || !Number.isFinite(confidence)) {
          this.options.onAbstractError?.(new Error("abstractor returned an invalid proposal"), {
            theme: cluster.theme,
          });
        } else {
          return { rule, confidence: clamp01(confidence) };
        }
      } catch (error) {
        this.options.onAbstractError?.(error, { theme: cluster.theme });
      }
    }
    return this.heuristicRule({ theme: cluster.theme, contents: cluster.contents });
  }

  /** 批量推广: 候选条目 → 聚类 → 每簇产 proposal → 落 review 队列 (不入记忆)。 */
  async runBatch(sourceRun: string, candidates: MemoryEntry[]): Promise<QueuedProposal[]> {
    const clusters = clusterByTheme(candidates);
    const created: QueuedProposal[] = [];
    for (const c of clusters) {
      const abstracted = await this.abstractCluster({
        theme: c.theme,
        contents: c.entries.map((e) => e.content),
        sources: c.entries.map((e) => e.source),
      });
      created.push(
        this.enqueue({
          rule: abstracted.rule,
          covers: c.entries.map((e) => e.id),
          confidence: abstracted.confidence,
          sourceRun,
        }),
      );
    }
    return created;
  }

  /**
   * 从存储里取最近的候选 (lesson/pattern/decision) 跑一批 —— 面板/工具/CLI 的统一触发点。
   * 已被队列里任意 proposal 覆盖过的实例会跳过, 避免反复点击产生重复提议。
   */
  async runRecent(sourceRun: string, limit = 100): Promise<QueuedProposal[]> {
    // 只跳过仍然有效的提议 (proposed/confirmed): 驳回是"这次不推广", 不是"永远不再提"。
    const covered = new Set<string>();
    for (const p of this.listQueue()) {
      if (p.status === "rejected") continue;
      for (const id of p.proposal.covers) covered.add(id);
    }
    const candidates = (await this.store.query({ limit })).filter(
      (e) =>
        (e.kind === "lesson" || e.kind === "pattern" || e.kind === "decision") &&
        !covered.has(e.id),
    );
    if (!candidates.length) return [];
    return this.runBatch(sourceRun, candidates);
  }

  /** 人工/模型直接提议一条规则 (仍进队列, 仍由人确认)。 */
  enqueueProposal(input: {
    rule: string;
    covers?: string[];
    confidence?: number;
    sourceRun?: string;
  }): QueuedProposal {
    const rule = input.rule.trim();
    if (!rule) throw new Error("proposal rule must not be empty");
    const confidence = input.confidence ?? 0.5;
    return this.enqueue({
      rule,
      covers: input.covers ?? [],
      confidence: Math.min(1, Math.max(0, confidence)),
      sourceRun: input.sourceRun ?? "manual",
    });
  }

  private enqueue(input: {
    rule: string;
    covers: string[];
    confidence: number;
    sourceRun: string;
  }): QueuedProposal {
    const proposal: QueuedProposal = {
      id: "p" + randomUUID().replace(/-/g, "").slice(0, 16),
      status: "proposed",
      sourceRun: input.sourceRun,
      proposal: {
        rule: input.rule,
        covers: input.covers,
        confidence: input.confidence,
        suggestedAction: "confirm",
        generatedAt: new Date().toISOString(),
      },
    };
    this.appendToQueue(proposal);
    return proposal;
  }

  listQueue(status?: ProposalStatus): QueuedProposal[] {
    const file = this.queueFile();
    if (!existsSync(file)) return [];
    const out: QueuedProposal[] = [];
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const parsed = parseProposalLine(line);
      // 坏行跳过而不是抛错: 一行截断不能让整个审阅面板失效。
      if (parsed && (status ? parsed.status === status : true)) out.push(parsed);
    }
    return out;
  }

  /**
   * 人工确认: proposal → rule (带确认记录 + generalizes 关联)。幂等。
   * async: MemoryStore 允许异步后端, 必须 await get/add —— 否则会"提议标记 confirmed 但 rule 没落盘"。
   */
  async confirm(id: string, by: string): Promise<{ ok: boolean; ruleId?: string; error?: string }> {
    const item = this.listQueue().find((p) => p.id === id);
    if (!item || item.status !== "proposed")
      return { ok: false, error: "proposal not found or not proposed" };
    const now = new Date().toISOString();
    const coverEntries: MemoryEntry[] = [];
    for (const cid of item.proposal.covers) {
      const hit = await this.store.get(cid);
      if (hit) coverEntries.push(hit);
    }
    const ruleEntry: MemoryEntry = {
      id: "r" + randomUUID().replace(/-/g, "").slice(0, 16),
      kind: "rule",
      content: item.proposal.rule,
      source: "generalizer:" + item.sourceRun,
      scope: "global",
      ts: { validAt: now, assertedAt: now },
      relations: coverEntries.map((e) => ({ type: "generalizes", toId: e.id })),
      confirmedBy: by,
      confirmedAt: now,
    };
    try {
      await this.store.add(ruleEntry);
    } catch (error) {
      // 落盘失败就不能标记 confirmed, 否则人工确认被静默丢掉。
      return { ok: false, error: String(error) };
    }
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
        const p = parseProposalLine(l);
        // 无法解析的行原样保留 (人工可修), 不因为一行坏数据丢整份队列。
        if (!p) return l;
        return p.id === id ? JSON.stringify({ ...p, status }) : l;
      });
    writeFileSync(file, out.join("\n"), "utf8");
  }
}
