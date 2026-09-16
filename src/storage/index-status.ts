// storage/index-status.ts — 派生索引的**只读自述面** (能力 / 自检 / FTS 状态)。
//
// 为什么独立: 这些方法一个字节都不写, 只回答"现在的索引是什么状态"。
// 它们的消费者是面板、CLI 与运维 —— 变化原因是"要观测什么", 而不是"怎么存"。
// 拆出去之后 file-store.ts 只剩读写编排与端口实现。
//
// 一条贯穿的原则: **降级必须可观测**。宁可如实说"现在是 LIKE 而不是 FTS", 也不要假装健康。
import type { RetrievalCapabilities, VerifyReport } from "../kernel/ports.ts";
import type { FtsIndex } from "./fts-index.ts";

export interface FtsStatus {
  available: boolean;
  degraded: string | null;
  indexed: number;
  expected: number;
}

export class IndexStatus {
  private readonly fts: FtsIndex;

  constructor(fts: FtsIndex) {
    this.fts = fts;
  }

  /**
   * 全文索引状态。注意 semantic:false 是**诚实**的 —— 没有 embedding 通道就不要宣称语义检索,
   * 上层据此决定降级策略 (而不是猜)。
   */
  capabilities(): RetrievalCapabilities {
    const available = this.fts.available;
    return {
      engine: available ? "sqlite-fts5+cjk" : "sqlite-like",
      fullText: available,
      cjk: available,
      semantic: false,
      graph: "relations",
      multiProcess: true,
    };
  }

  /** 降级读数 (available/degraded/行数/应有行数)。 */
  ftsStatus(expected: number): FtsStatus {
    return {
      available: this.fts.available,
      degraded: this.fts.degradation,
      indexed: this.fts.count(),
      expected,
    };
  }

  /**
   * 一致性自检: 真相条目数 == 索引行数, 全文行数 == 索引行数。
   * 不追求逐字段 diff (那是 conformance 的事), 只给运维一眼可见的"有没有漂移"。
   */
  verify(truth: number, index: number, warnings: readonly string[]): VerifyReport {
    const problems: string[] = [];
    const fullText = this.fts.available ? this.fts.count() : undefined;
    if (truth !== index) {
      problems.push(`truth/index mismatch: ${truth} truth entries vs ${index} index rows`);
    }
    if (fullText !== undefined && fullText !== index) {
      problems.push(`index/fulltext mismatch: ${index} rows vs ${fullText} fulltext rows`);
    }
    for (const w of warnings.slice(0, 10)) problems.push("parse warning: " + w);
    return {
      ok: problems.length === 0,
      truth,
      index,
      ...(fullText === undefined ? {} : { fullText }),
      problems,
    };
  }
}
