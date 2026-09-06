// src/capture/pipeline.ts — 捕获管道: 把 turn 捕获并持久化到存储。
// 这是 Stage 3 (DSH adapter) 会调用的入口: 一轮 turn → 记忆入库。
// 依赖: capture engine (纯逻辑) + FileBackend (存储)。指纹集用于跨轮去重。
import { captureTurn, type CaptureOptions, type TurnInput, type CaptureResult } from "./engine.ts";
import type { FileBackend } from "../storage/file-store.ts";

export class CapturePipeline {
  private readonly hashes = new Set<string>();

  constructor(private readonly store: FileBackend) {}

  /** 捕获一轮并入库。返回本次实际新增的条目。 */
  run(input: TurnInput, opts: CaptureOptions = {}): CaptureResult {
    const result = captureTurn(input, opts, this.hashes);
    for (const e of result.entries) {
      this.store.add(e);
      this.hashes.add(e.id.slice(1)); // "c<hash>" → hash
    }
    return result;
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
