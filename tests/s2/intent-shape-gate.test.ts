// tests/s2/intent-shape-gate.test.ts — 意图召回通道也必须有「未完成祈使句」闸门。
//
// 为什么需要它 (2026-10-06 归因实测): 真库 1187 条 active 里, 含祈使/未完成语气且无收尾
// 断言的条目被**自动注入过 171 次**。逐条回溯它们走的是哪条通道后得到的关键事实:
// **全部来自意图召回这一支**, 一条都不来自 always-on  因为保底通道实际只选得出
// 跨项目规则与 agent 偏好 (实测 7 个项目跑同一份库, 选出来都是同 9 条, 项目条目零进)。
// 所以只在 always-on 设闸门等于没修: 那个 171 次的泄漏点原封不动。
//
// 本文件把「两条通道都必须过闸」钉成断言  这正是本仓反复强调的「两个入口口径分叉」形态。
import { describe, expect, it } from 'vitest';
import { createTriggerCache } from '../../src/adapters/dsh/trigger-cache.ts';
import { selectAlwaysOnDetailed } from '../../src/trigger/policy.ts';
import { estimateTokens } from '../../src/kernel/ranking.ts';
import { looksUnfinished } from '../../src/kernel/completion-shape.ts';

const T = { validAt: '2026-10-01T00:00:00.000Z', assertedAt: '2026-10-01T00:00:00.000Z' };

/** 造一条最小 MemoryEntry (只带这条用例读到的字段)。 */
function entry(over: Record<string, unknown>) {
  return { id: 'x', kind: 'lesson', scope: 'project', project: 'p', source: 't', content: '', ts: T, ...over };
}

/** 那条真实污染源的逐字正文 (取自真库 c06db1cc6a422e357, 被注入过 8 次)。 */
const STALE_BUG =
  '现在有一个非常严重的bug! gh-pool 这整个项目, 似乎后面这个 2FA 授权这个步骤 他那个队列并不会帮我们执行，或者说执行失败了，总之有问题';
const FRESH_LESSON = '出口口令必须按身份取, 不能用共享口令统一设置。';

function makeCache(recallHits: unknown[]) {
  const facade = {
    recall: () => ({ hits: recallHits, tokens: 0, degraded: [] }),
    alwaysOn: async () => [],
  } as never;
  return createTriggerCache({ facade, revision: () => 1, budgetTokens: 400, maxEntries: 5 });
}

describe('意图召回通道的形状闸门', () => {
  it('### 负例: 那条被注入过 8 次的过期待办, 不得再自动注入', () => {
    const stale = entry({ id: 'stale', content: STALE_BUG });
    const fresh = entry({ id: 'fresh', kind: 'pattern', content: FRESH_LESSON });
    const cache = makeCache([{ entry: stale, channels: ['bm25'] }, { entry: fresh, channels: ['bm25'] }]);
    const out = cache.recallFor('gh-pool 2FA 队列', { inject: true, budgetTokens: 400 }, { project: 'p', lineage: ['p'] });
    const ids = out.map((e) => e.id);
    expect(ids, '过期待办必须被闸门挡下').not.toContain('stale');
    expect(ids, '同批的知识型条目必须照常放出 (闸门不许一锅端)').toContain('fresh');
  });

  it('闸门判据与 always-on 同源 (同一个 looksUnfinished, 不是各写一份)', () => {
    // 断言「被挡」这件事与判据一致: 若判据说它未完成, 通道就必须挡。
    expect(looksUnfinished(STALE_BUG)).toBe(true);
    expect(looksUnfinished(FRESH_LESSON)).toBe(false);
    const cache = makeCache([{ entry: entry({ id: 's', content: STALE_BUG }), channels: ['bm25'] }]);
    expect(cache.recallFor('x', { inject: true, budgetTokens: 400 })).toEqual([]);
  });

  it('全被挡掉时返回空 (不得退回"照发")', () => {
    const cache = makeCache([
      { entry: entry({ id: 'a', content: '你去看看，修改一下就可以' }), channels: ['bm25'] },
      { entry: entry({ id: 'b', content: '帮我优化一下：前端支持一键刷新' }), channels: ['bm25'] },
    ]);
    expect(cache.recallFor('x', { inject: true, budgetTokens: 400 })).toEqual([]);
  });
});

describe('always-on 的形状闸门', () => {
  it('### 负例: 形状上是待办的条目不得进常驻通道 (与意图通道同判据)', () => {
    const entries = [
      entry({ id: 'stale', kind: 'decision', content: STALE_BUG }),
      entry({ id: 'ok', kind: 'decision', content: '口子按身份取, 已落地并验证。' }),
    ];
    const sel = selectAlwaysOnDetailed(entries as never, { project: 'p', budgetTokens: 4000, estimate: estimateTokens });
    expect(sel.entries.map((e) => e.id)).toEqual(['ok']);
  });
});
