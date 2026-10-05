// src/adapters/dsh/gateway-injection.ts — 注入预览的投影 (从 gateway-memory.ts 拆出)。
//
// 为什么拆: gateway-memory.ts 因加入本功能而超出 400 行上限 (项目硬约束)。
// 拆分口径按**职责**: gateway-memory 管"记忆条目的查询/编辑面",
// 本文件只管"注入账本面" (用户唯一能感知的记忆行为就是"注入了什么")。
import { estimateTokens } from "../../kernel/ranking.ts";
import { selectAlwaysOnDetailed } from "../../trigger/policy.ts";
import type { MemoryEntry } from "../../kernel/types.ts";

/** 注入预览的投影形状。 */
export interface AlwaysOnPreview {
  /** 会进保底通道的条目 (与实际注入同一实现)。 */
  picked: Array<{ id: string; kind: string; scope: string; content: string; tokens: number }>;
  /** **本是候选但因配额没进来**的条目 (含被挡的规则) —— 这是本出口最要紧的部分。 */
  blocked: Array<{ id: string; kind: string; content: string; tokens: number; reason: string }>;
  budgetTokens: number;
  selectedTokens: number;
}

/**
 * 注入预览投影。
 *
 * 为什么必须有这个出口 (2026-09-18): 面板此前有"新沉淀/搜索/待审"三个 tab, 但**没有"注入"** ——
 * 而注入是**用户唯一能感知的记忆行为** (他最初的抱怨正是"搜索时前面几条都是规则")。
 * 更糟的是: 被配额挡掉的规则是**完全静默**的 (实测真实库 9 条已确认规则里 2 条永远注入不进)。
 *
 * 与 `selectAlwaysOn` **共用同一实现** (调用方走 selectAlwaysOnDetailed), 因此预览与实际注入不会分叉。
 */
/**
 * 装配注入预览的读取器 (从 index.ts 拆出)。
 *
 * 为什么要走 `selectAlwaysOnDetailed` 而不是重写一份逻辑: **预览与实际注入必须同源** ——
 * 否则面板显示的"会注入什么"与真机注入的就可能分叉 (本项目反复强调的坑)。
 */
/**
 * always-on 带报告读取器的形状 (装配方与消费方**共用一份定义**)。
 *
 * ⚠ `blocked[].content` 曾经**缺这一环** (2026-09-18, §565): 类型里只有 id/kind/tokens/reason,
 * 于是下游投影只能填 `""`, 而面板渲染 `{b.content}` ⇒ **用户只看到徽标, 看不出被挡的是什么**。
 * 而"哪些被挡了"正是这个出口存在的理由。
 */
export type AlwaysOnDetailedReader = (opts: { project?: string }) => Promise<{
  entries: Array<{ id: string; kind: string; scope: string; content: string }>;
  blocked: Array<{ id: string; kind: string; content: string; tokens: number; reason: string }>;
}>;

/** 实现 —— 返回类型**直接用那个别名**, 免得两处定义再次分叉。 */
export function makeAlwaysOnDetailedReader(
  loadAll: () => Promise<readonly MemoryEntry[]>,
  budgetTokens = 400,
): AlwaysOnDetailedReader {
  return async (opts) => {
    const sel = selectAlwaysOnDetailed(await loadAll(), {
      ...(opts.project ? { project: opts.project } : {}),
      budgetTokens,
      estimate: estimateTokens,
    });
    return {
      entries: sel.entries.map((e) => ({ id: e.id, kind: e.kind, scope: e.scope, content: e.content })),
      blocked: sel.blocked.map((b) => ({
        id: b.id,
        kind: b.kind,
        content: b.content,
        tokens: b.tokens,
        reason: b.reason,
      })),
    };
  };
}

/** 注入预览端点所需的最小依赖面 (只要"能读到带报告的 always-on"即可)。 */
export interface AlwaysOnPreviewDeps {
  alwaysOnDetailed?: (opts: { project?: string }) => Promise<{
    entries: Array<{ id: string; kind: string; scope: string; content: string }>;
    /** `content` 是面板显示"哪些被挡了"的依据 (§565)。 */
    blocked: Array<{ id: string; kind: string; content: string; tokens: number; reason: string }>;
  }>;
}

/**
 * 端点实现 (从 gateway.ts 拆出, 让那边的行数回到上限内)。
 * 缺省时返回**空集**而不是抛错: 面板据此显示"未接线" (与 captureReviewQueue 同一取舍) ——
 * "这个机制没接线"与"真的没有内容"是两件事, 不能混。
 */
export async function handleAlwaysOnPreview(
  deps: AlwaysOnPreviewDeps,
  project: string,
  budgetTokens: number,
): Promise<AlwaysOnPreview> {
  return await projectAlwaysOnPreview(
    async () => {
      if (!deps.alwaysOnDetailed) return { entries: [], blocked: [], budgetTokens };
      const sel = await deps.alwaysOnDetailed({ project });
      return {
        entries: sel.entries.map((e) => ({ id: e.id, kind: e.kind, scope: e.scope, content: e.content })),
        // 同 §565: content 一路带到面板, 否则用户看不出被挡的是什么。
        blocked: sel.blocked.map((b) => ({
          id: b.id,
          kind: b.kind,
          content: b.content,
          tokens: b.tokens,
          reason: b.reason,
        })),
        budgetTokens,
      };
    },
    { estimate: estimateTokens },
  );
}

export async function projectAlwaysOnPreview(
  read: () => Promise<{
    entries: Array<{ id: string; kind: string; scope: string; content: string }>;
    // 同 `makeAlwaysOnDetailedReader`: content 必须一路带到面板 (§565)。
    blocked: Array<{ id: string; kind: string; content: string; tokens: number; reason: string }>;
    budgetTokens: number;
  }>,
  deps: { estimate: (t: string) => number },
): Promise<AlwaysOnPreview> {
  const sel = await read();
  return {
    picked: sel.entries.map((e) => ({
      id: e.id,
      kind: e.kind,
      scope: e.scope,
      content: e.content.slice(0, 400),
      tokens: deps.estimate(e.content) + 8,
    })),
    // ⚠ `content` 此前硬编码空串 ⇒ 面板那行只剩徽标 (面板渲染 `{b.content}`)。
    // 截断上限与 `picked` 一致 (400): 这个出口是给人看的预览, 不是全文出口。
    blocked: sel.blocked.map((b) => ({
      id: b.id,
      kind: b.kind,
      content: b.content.slice(0, 400),
      tokens: b.tokens,
      reason: b.reason,
    })),
    budgetTokens: sel.budgetTokens,
    selectedTokens: sel.entries.reduce((n, e) => n + deps.estimate(e.content) + 8, 0),
  };
}
