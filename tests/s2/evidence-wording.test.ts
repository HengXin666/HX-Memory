// tests/s2/evidence-wording.test.ts — 证据链的 reasons **必须区分"无原文"与"漏捕获"**。
//
// 为什么需要它 (2026-09-18, §562): 实测真库 322 条无血缘里 **305 条是 \`session:tool\`**
// (工具直接写入), 它们**本来就不是从对话里抽的** —— "没有原文可追"是**语义正确**。
//
// 而旧措辞对两类都说"**没有记录血缘 (写入时未捕获 episode 引用)**":
// "未捕获"暗示**漏掉了**, 于是那 305 条读起来像缺陷。**那与事实不符。**
//
// 判据只用 \`entry.source\` (端口不扩): \`session:tool\` 是可判定的"工具写入"标记。
import { describe, expect, it } from "vitest";
import { buildEvidenceChain } from "../../src/app/evidence.ts";
import type { MemoryEntry } from "../../src/kernel/types.ts";

const entry = (id: string, source: string): MemoryEntry =>
  ({
    id,
    kind: "fact",
    content: "x",
    source,
    scope: "agent",
    ts: { validAt: "2026-01-01T00:00:00.000Z", assertedAt: "2026-01-01T00:00:00.000Z" },
  }) as MemoryEntry;

/** 最小 store 桩 (只要 get)。 */
const storeOf = (e: MemoryEntry) => ({ get: async (_id: string) => e });

describe("证据链 reasons 的措辞", () => {
  it("**工具写入** ⇒ 明说'无原文可溯源', 而不是'未捕获'", async () => {
    const e = entry("m1", "session:tool");
    const chain = await buildEvidenceChain(storeOf(e), undefined, "m1");
    expect(chain).not.toBeNull();
    const reason = chain!.reasons.join(" ");
    expect(reason).toContain("工具直接写入");
    expect(reason).toContain("无原文可溯源");
    // 关键: **不能**再用那个暗示"漏掉了"的措辞
    expect(reason).not.toContain("未捕获");
  });

  it("**对话沉淀但无血缘** ⇒ 保留'未捕获'措辞 (那确实可能是漏了)", async () => {
    const e = entry("m2", "session:session-abc");
    const chain = await buildEvidenceChain(storeOf(e), undefined, "m2");
    expect(chain!.reasons.join(" ")).toContain("未捕获");
  });

  it("两类措辞**必须不同** (同一句话覆盖两种情况就是本缺陷)", async () => {
    const a = await buildEvidenceChain(storeOf(entry("m1", "session:tool")), undefined, "m1");
    const b = await buildEvidenceChain(storeOf(entry("m2", "session:session-abc")), undefined, "m2");
    expect(a!.reasons).not.toEqual(b!.reasons);
  });

  it("两种情况都仍是 traceable=false (措辞改了, 判定没改)", async () => {
    for (const src of ["session:tool", "session:session-abc"]) {
      const chain = await buildEvidenceChain(storeOf(entry("m1", src)), undefined, "m1");
      expect(chain!.traceable, src).toBe(false);
    }
  });

  it("条目不存在 ⇒ null (与'存在但无血缘'不同)", async () => {
    const chain = await buildEvidenceChain({ get: async () => null }, undefined, "mx");
    expect(chain).toBeNull();
  });
});
