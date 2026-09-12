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

export interface PipelineOptions {
  /** AI 结构化增强 (可选; 默认启发式兜底)。 */
  structurer?: TurnStructurer;
}

export class CapturePipeline {
  private readonly hashes = new Set<string>();
  private readonly structurer: TurnStructurer;

  // 显式字段 + 赋值 (不用 TS 参数属性): Node strip-only 模式不支持, 子进程 import 时会崩。
  private readonly store: MemoryStore;

  constructor(store: MemoryStore, opts: PipelineOptions = {}) {
    this.store = store;
    this.structurer = opts.structurer ?? heuristicStructurer();
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
      await this.store.add(enhanced); // 端口允许异步后端: 必须 await
      this.hashes.add(e.id.slice(1)); // "c<hash>" → hash
      enriched.push(enhanced);
    }
    return { ...result, entries: enriched, deduped: result.deduped + skipped };
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