// src/app/evidence.ts — 证据链: 一条记忆 → 产生它的原始对话轮次。
//
// 依据: docs/evidence-chain.md。产品承诺"可溯源", 而 derivedFrom 存了 episode id 却长期
// 没有查询路径 (episode-store 无 byId, facade 无 episode 面) —— "这句话是怎么来的"回答不了。
//
// 三条实现纪律 (全部有契约测试钉住, tests/s2/evidence-chain.test.ts):
//   1. **原文优先**: 返回未经改写的 episode 原文, 绝不用 content/摘要冒充 (与 recall 同一硬规则);
//   2. **如实降级**: 取不到就说清缺在哪, 而不是返回看起来成功的空结果 ——
//      静默的空是最坏的失败形态 (调用方会当成"确实没有"而不再怀疑);
//   3. **顺序还原对话**: 按 at 升序返回, 据此还原"用户问 → 助手答"的次序。
//
// 为什么独立成文件: 它是**查询**逻辑而非编排 (facade 的职责是编排与门面); 且三种降级原因
// 的判定与文案需要单独可测, 混在 facade 里会让"能力边界"与"业务编排"耦合在一起。
import type { EvidenceChain, EvidenceSource, FacadeStore } from "./facade-types.ts";

/**
 * 组装一条记忆的完整证据链。
 *
 * 返回 null 仅表示"没有这个条目"; 条目存在但血缘不全时返回 traceable:false 的链,
 * 并在 reasons 里说明缺在哪 (三种可区分: 未记录血缘 / 未接证据源 / 原文已不可取)。
 */
export async function buildEvidenceChain(
  store: Pick<FacadeStore, "get">,
  evidence: EvidenceSource | undefined,
  id: string,
): Promise<EvidenceChain | null> {
  const entry = await store.get(id);
  if (!entry) return null;
  const episodeIds = [...(entry.derivedFrom ?? [])];
  const reasons: string[] = [];
  let episodes: EvidenceChain["episodes"] = [];

  if (!episodeIds.length) {
    // ⚠ **措辞必须区分两类"没有血缘"** (2026-09-18, §562):
    //
    // 实测真库 322 条无血缘里:
    //   · **305 条 `source = session:tool`** —— 它们是**工具写入** (`memory_save` 等),
    //     **本来就不是从对话里抽的**, 所以"没有原文可追"是**语义正确**, 不是缺陷;
    //   · 6 条 `session:<uuid>` + 8 条 generalizer + 1 条 user —— 这类**可能**是漏捕获。
    //
    // 而旧措辞对两类都说"**没有记录血缘 (写入时未捕获 episode 引用)**" ——
    // "未捕获"暗示**漏掉了**, 让工具写入的 305 条读起来像缺陷。
    // 那与事实不符: 它们没有原文可追, 因为没有"产生它们的对话轮次"。
    //
    // 判据只用 `entry.source` (端口不扩): `session:tool` 是可判定的"工具写入"标记。
    if (entry.source === "session:tool") {
      reasons.push("该条目由工具直接写入 (非对话沉淀), 没有对应的对话轮次 —— 无原文可溯源");
    } else {
      reasons.push("该条目没有记录血缘 (写入时未捕获 episode 引用)");
    }
  } else if (!evidence) {
    reasons.push("未接入 episode 原文源 (装配时缺 evidence)");
  } else {
    const found = await evidence.byIds(episodeIds);
    episodes = found
      .map((e) => ({ id: e.id, role: e.role, text: e.text, at: e.at, turn: e.turn }))
      .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    const missing = episodeIds.filter((x) => !episodes.some((e) => e.id === x));
    if (missing.length) {
      // 常见于原文已过保留期 (prune 按整天删除)。如实报出, **不补其它内容顶替**。
      reasons.push("有 " + missing.length + " 条原文已不可取 (可能已过保留期): " + missing.join(","));
    }
  }

  return {
    entryId: entry.id,
    content: entry.content,
    source: entry.source,
    episodeIds,
    episodes,
    traceable: episodeIds.length > 0 && episodes.length === episodeIds.length,
    reasons,
  };
}
