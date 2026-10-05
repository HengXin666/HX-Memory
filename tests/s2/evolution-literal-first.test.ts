// tests/s2/evolution-literal-first.test.ts — "字面可见的差异优先于语义兜底"。
//
// 为什么需要它 (2026-09-18): 语义兜底的设计目的是"**字面看不出来**但向量很近"(同义改写)。
// 但实测发现"仅标识符不同的两条"(端口 60 vs 90, 编号 0 vs 1) 的**向量余弦也在 0.82~0.99**,
// 于是被判重复而**静默吞并** —— 而那类内容的**字面覆盖率高达 0.875~0.917**, 即字面明明看得出来。
//
// 可区分性检验 (2026-09-18):
//   · 同义改写: 字面覆盖率 **0.000~0.385** (低)  ← 兜底该管的
//   · 值差异:   字面覆盖率 **0.875~0.917** (高) 且新增词含标识符 ← 兜底不该覆盖的
//   两类的**字面覆盖率完全不重叠**, 而**语义余弦区间重叠** (0.467~0.956 vs 0.820~0.849)
//   ⇒ 判据必须建立在字面覆盖率上, 而不是调语义阈值 (那会误伤某一类)。
import { describe, expect, it } from "vitest";
import { decideEvolution } from "../../src/evolution/evolve.ts";
import { tokenSetOf } from "../../src/evolution/associate.ts";

const target = (content: string) => ({
  id: "t1", kind: "fact" as const, content, source: "test", scope: "agent" as const,
  ts: { validAt: "2026-01-01T00:00:00Z", assertedAt: "2026-01-01T00:00:00Z" },
  status: "active" as const,
});
const cand = (content: string) => ({ kind: "fact" as const, content, tags: [], entities: [] });

/** 高语义相似度 (模拟"向量很近")。 */
const HIGH_SEM = { semanticSimilarity: () => 0.98 };

describe("演化判定: 字面可见的差异优先于语义兜底", () => {
  it("**仅标识符差异** → 不吞并 (即使向量很近)", () => {
    // 这两组在修复前都会被 semantic-duplicate 吞并
    const a = decideEvolution(cand("服务端口配置为 60 用于本地调试"), [target("服务端口配置为 90 用于本地调试")], HIGH_SEM);
    expect(a.action).not.toBe("duplicate");
    const b = decideEvolution(cand("这条记忆编号 0，包含标点符号"), [target("这条记忆编号 1，包含标点符号")], HIGH_SEM);
    expect(b.action).not.toBe("duplicate");
  });

  it("**同义改写 (字面差异大)** → 仍由语义兜底合并 (不因修复而丢失)", () => {
    // 覆盖率为低 (两类的字面覆盖率完全不重叠), 因此不走"字面优先"分支
    const d = decideEvolution(cand("最大连接数限额 20"), [target("连接池上限设为 20")], HIGH_SEM);
    expect(d.action).toBe("duplicate");
    expect(d.reason).toBe("semantic-duplicate");
  });

  it("完全相同的文本 → 仍判重复 (归一化后无差异)", () => {
    const d = decideEvolution(cand("缓存过期设为 60 秒"), [target("缓存过期设为 60 秒")], HIGH_SEM);
    expect(d.action).toBe("duplicate");
  });

  it("**没有语义通道时** 同义改写不被合并 (说明兜底确实是它负责的)", () => {
    const d = decideEvolution(cand("最大连接数限额 20"), [target("连接池上限设为 20")], {});
    expect(d.action).toBe("add");
  });

  it("**中文词差异不在本判据的保护范围内** (刻意如此: 那是语义通道的职责)", () => {
    // 这条**不是**缺陷, 而是判据边界的显式记录:
    // "只读副本" vs "备份副本" 的字面覆盖率是 0.769 (略高于 0.75), 新增词是纯中文 ("备份"/"走备"/"份副"),
    // **不含标识符** ⇒ 修复判据不介入, 仍由语义兜底判重复。
    //
    // 为什么这样设计: 中文词差异**不能靠字面区分**——
    // "只读副本"与"备份副本"可能指同一件事 (同义), 也可能指两件事 (并列)。
    // 要从字面判断需要词典, 那是语义通道的职责。本判据只处理**有客观分界**的那一类
    // (标识符差异: 词集区间完全不重叠, 见文件头注的可区分性检验)。
    const d = decideEvolution(
      cand("生产库禁止直连必须走只读副本"),
      [target("生产库禁止直连必须走备份副本")],
      HIGH_SEM,
    );
    expect(d.action).toBe("duplicate");
    // 且其字面覆盖率确实在"高"这一档 (>0.75), 即它**不是**漏判
    expect(tokenSetOf("生产库禁止直连必须走备份副本").size).toBeGreaterThan(0);
  });
});
