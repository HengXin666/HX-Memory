// src/capture/pipeline.ts — 捕获管道: 把 turn 捕获并持久化到存储。
// 这是 Stage 3 (DSH adapter) 会调用的入口: 一轮 turn → 记忆入库。
// 依赖: capture engine (纯逻辑) + FileBackend (存储)。指纹集用于跨轮去重。
// v2: 接入可选 TurnStructurer (AI 结构化增强) — 先落确定性捕获, 再结构化增强;
//     结构化失败不影响入库 (增强不是门槛)。
import { captureTurn, type CaptureOptions, type TurnInput, type CaptureResult } from "./engine.ts";
import type { FileBackend } from "../storage/file-store.ts";
import { heuristicStructurer, type TurnStructurer } from "./structurer.ts";

export interface PipelineOptions {
  /** AI 结构化增强 (可选; 默认启发式兜底)。 */
  structurer?: TurnStructurer;
}

export class CapturePipeline {
  private readonly hashes = new Set<string>();
  private readonly structurer: TurnStructurer;

  constructor(
    private readonly store: FileBackend,
    opts: PipelineOptions = {},
  ) {
    this.structurer = opts.structurer ?? heuristicStructurer();
  }

  /** 捕获一轮并入库。返回本次实际新增的条目。 */
  async run(input: TurnInput, opts: CaptureOptions = {}): Promise<CaptureResult> {
    const result = captureTurn(input, opts, this.hashes);
    const enriched: typeof result.entries = [];
    for (const e of result.entries) {
      const enhanced = await this.enrich(e);
      this.store.add(enhanced);
      this.hashes.add(e.id.slice(1)); // "c<hash>" → hash
      enriched.push(enhanced);
    }
    return { ...result, entries: enriched };
  }

  private async enrich(e: (typeof import("./engine.ts")) extends never ? never : import("../kernel/types.ts").MemoryEntry): Promise<import("../kernel/types.ts").MemoryEntry> {
    try {
      const s = await this.structurer.structure({ text: e.content, project: e.project });
      if (!s || !s.summary) return e;
      return {
        ...e,
        content: e.content, // 原文保留 (truth-in-files)
        tags: s.tags.length ? s.tags : e.tags,
        structured: s,
      };
    } catch {
      return e; // AI 失败 → 原样落盘, 不丢
    }
  }

  /** 从存储回填指纹 (重启后去重仍有效)。 */
  async warmUp(): Promise<number> {
    const all = this.store.query({});
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
