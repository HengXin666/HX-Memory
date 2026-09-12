// src/capture/pipeline.ts — 捕获管道: 把 turn 捕获并持久化到存储。
// 这是 DSH adapter 会调用的入口: 一轮 turn → 记忆入库。
// 依赖: capture engine (纯逻辑) + MemoryStore 端口 (不依赖具体存储实现)。
// v2: 接入可选 TurnStructurer (AI 结构化增强) — 先落确定性捕获, 再结构化增强;
//     结构化失败不影响入库 (增强不是门槛)。
// v3 (决策反转): 记忆层从**转录**改为**提炼** —— 有 conclusion 时 content 用结论,
//     原始问答逐字留在 episode 日志里并由 derivedFrom 指回 (ADR-018 不受影响)。
//     没有 conclusion (启发式兜底/AI 失败) 时 content 仍是原文, 与 v2 行为一致。
import {
  captureTurn,
  isInterrogative,
  type CaptureOptions,
  type TurnInput,
  type CaptureResult,
} from "./engine.ts";
import type { MemoryEntry } from "../kernel/types.ts";
import type { MemoryStore } from "../kernel/ports.ts";
import { heuristicStructurer, type TurnStructurer } from "./structurer.ts";
import { planStructuralLinks } from "../evolution/link.ts";
import type { Relation } from "../kernel/types.ts";

export interface PipelineOptions {
  /** AI 结构化增强 (可选; 默认启发式兜底)。 */
  structurer?: TurnStructurer;
  /**
   * 单次写入最多建几条结构关联边 (默认 3; 0 = 关闭)。
   *
   * 为什么捕获路径也要建边: 结构关联 (`planStructuralLinks`) 此前只在
   * `facade.remember()` 里调用, 而`自动捕获`走的是 pipeline.write 直连存储 ——
   * 于是"日常对话沉淀下来的记忆"永远不建边。实测真实库 80 条里 56 条孤立,
   * 边只有规则推广产生的 generalizes, 图检索因此无东西可扩展。
   */
  maxStructuralLinks?: number;
}

export class CapturePipeline {
  private readonly hashes = new Set<string>();
  private readonly structurer: TurnStructurer;

  // 显式字段 + 赋值 (不用 TS 参数属性): Node strip-only 模式不支持, 子进程 import 时会崩。
  private readonly store: MemoryStore;
  private readonly maxStructuralLinks: number;

  constructor(store: MemoryStore, opts: PipelineOptions = {}) {
    this.store = store;
    this.structurer = opts.structurer ?? heuristicStructurer();
    this.maxStructuralLinks = opts.maxStructuralLinks ?? 3;
  }

  /**
   * 捕获一轮并入库。返回本次实际新增的条目。
   *
   * 疑问句开头的轮次有一条额外规则: **只有结构化器读出结论才落盘**。
   * 因为问句本身不是记忆, 它后面的结论才是; 读不出结论说明这一轮只是讨论,
   * 存下来就是噪声 (实测旧路径 15% 的记忆是问句转录)。
   */
  async run(input: TurnInput, opts: CaptureOptions = {}): Promise<CaptureResult> {
    const result = captureTurn(input, opts, this.hashes);
    const enriched: MemoryEntry[] = [];
    const needsConclusion = isInterrogative(input.text);
    let skipped = 0;
    for (const e of result.entries) {
      const enhanced = await this.enrich(e, input.answer);
      if (needsConclusion && !enhanced.structured?.conclusion) {
        skipped++;
        continue; // 读不出结论 → 不落盘
      }
      // withStructuralLinks 是 async (要读既有条目做共现比较), 必须 await。
      const linked = await this.withStructuralLinks(enhanced);
      await this.store.add(linked); // 端口允许异步后端: 必须 await
      this.hashes.add(e.id.slice(1)); // "c<hash>" → hash
      enriched.push(linked);
    }
    return { ...result, entries: enriched, deduped: result.deduped + skipped };
  }

  /**
   * 给条目补结构关联边 (实体/标签共现)。
   *
   * 为什么在这里而不是 enrich 里: enrich 只做"单条文本 → 结构化字段", 不知道库里还有什么;
   * 建边需要**与既有条目比较**, 是另一件事。放在写入前一步, 失败也不影响落盘。
   * 候选面用 all() (捕获频率低, 且正确性优先于省这一读)。
   */
  private async withStructuralLinks(entry: MemoryEntry): Promise<MemoryEntry> {
    if (this.maxStructuralLinks <= 0) return entry;
    if (!(entry.tags ?? []).length && !(entry.entities ?? []).length) return entry;
    try {
      const existing = await this.store.all();
      const planned = planStructuralLinks(entry, existing, { maxLinks: this.maxStructuralLinks });
      if (!planned.length) return entry;
      const merged: Relation[] = [...(entry.relations ?? [])];
      for (const rel of planned) {
        if (merged.some((r) => r.type === rel.type && r.toId === rel.toId)) continue;
        merged.push(rel);
      }
      return merged.length === (entry.relations ?? []).length ? entry : { ...entry, relations: merged };
    } catch {
      return entry; // 建边是增强: 失败不影响落盘
    }
  }

  private async enrich(e: MemoryEntry, answer?: string): Promise<MemoryEntry> {
    try {
      const s = await this.structurer.structure({
        text: e.content,
        ...(answer ? { answer } : {}),
        ...(e.project ? { project: e.project } : {}),
      });
      if (!s || !s.summary) return e;
      // 只有 AI 给出**结论**时才替换 content; 否则保留原文 (失败/无结论都不丢信息)。
      const conclusion = s.conclusion?.trim();
      return {
        ...e,
        ...(conclusion ? { content: conclusion } : {}),
        tags: s.tags.length ? s.tags : e.tags,
        ...(s.entities?.length ? { entities: s.entities } : {}),
        structured: s,
      };
    } catch {
      return e; // AI 失败 → 原样落盘, 不丢
    }
  }

  /** 从存储回填指纹 (重启后去重仍有效)。全量读取: 只回填最近 N 条会让老记忆被重复捕获。 */
  async warmUp(): Promise<number> {
    const all = await this.store.all();
    let n = 0;
    for (const e of all) {
      if (e.id.startsWith("c")) {
        this.hashes.add(e.id.slice(1));
        n++;
      }
    }
    return n;
  }
}