// tests/s2/empty-answer-two-tier.test.ts — 空结果必须**可诊断**: 两种完全不同的处境不能答成同一句话。
//
// 为什么需要它 (2026-10-06 用户实测): 近 7 天 24 次主线程检索里 13 次拿到
// "No relevant memory found.", 而其中 **13/13 在库里都有字面命中的条目** 
// 它们全被「范围未知 + scopeRequired」挡掉了 (见 docs/memory-failure-audit-20261006.md 第三节)。
//
// 后果不是「少给几条」, 而是**模型把不知道伪装成知道**: 工具描述里写死了
// 「if it returns nothing, that record does not exist」, 于是它会照着这句断定某件事从未发生。
//
// 判据 (两档):
//   · 库里连沾边候选都没有  ⇒ 保持 "No relevant memory found.";
//   · 有候选但不属于当前工作区 ⇒ 明确说清, 并把候选**给出去** (标 LOW CONFIDENCE),
//     而不是清空。这与上游三家的默认一致 (mem0 threshold 0.1 / Graphiti min_score 0 /
//     MIRIX 强取满 top-k): 低置信也要给, 但**让模型知道置信低**。
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMemoryStack } from '../../src/app/stack.ts';
import { registerMemoryTools } from '../../src/adapters/dsh/tools.ts';

const T = { validAt: '2026-01-01T00:00:00Z', assertedAt: '2026-01-01T00:00:00Z' };

function makeCtx(tools: Map<string, unknown>) {
  return {
    tools: {
      register: (tool: { name: string }) => {
        tools.set(tool.name, tool);
        return () => tools.delete(tool.name);
      },
    },
  } as never;
}

async function search(root: string, scopeOf: (() => unknown) | undefined, query: string) {
  const stack = openMemoryStack(root, { embedder: null });
  try {
    const tools = new Map<string, { execute: (a: unknown, e: unknown) => Promise<string> }>();
    registerMemoryTools(makeCtx(tools), {
      store: stack.store,
      generalizer: { propose: async () => ({}) } as never,
      facade: stack.facade,
      ...(scopeOf ? { scopeOf: scopeOf as never } : {}),
    });
    return await tools.get('memory_search')!.execute({ query, limit: 5 }, {} as never);
  } finally {
    stack.close();
    rmSync(root, { recursive: true, force: true });
  }
}

describe('memory_search 空结果的两档回答', () => {
  it('### 负例: 库里连沾边候选都没有 ⇒ 保持原话 (不臆造候选)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hxmem-empty-'));
    const stack = openMemoryStack(root, { embedder: null });
    try {
      await stack.store.add({ id: 'x', kind: 'fact', scope: 'project', project: 'p', source: 't', ts: T, content: '无关内容 zzz' } as never);
    } finally { stack.close(); }
    const out = await search(root, () => ({ project: 'p', lineage: ['p'] }), '量子退相干实验装置校准');
    expect(out).toBe('No relevant memory found.');
  });

  it('### 范围未知时: 有候选就给出**计数与归属**, 不吐正文 (红线折中)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hxmem-empty2-'));
    const stack = openMemoryStack(root, { embedder: null });
    try {
      await stack.store.add({ id: 'a1', kind: 'fact', scope: 'project', project: 'HXLoLi-Music', source: 't', ts: T, content: '本机 libass 是经过魔改的版本, 1img 扩展标签可以生效' } as never);
    } finally { stack.close(); }
    // scopeOf 返回 undefined = 范围未知 (那 13 次空手的真实形态)。
    const out = await search(root, undefined, 'libass 魔改 1img');
    expect(out, '不得再是一句空话').not.toBe('No relevant memory found.');
    expect(out, '必须说清候选不在本工作区').toMatch(/outside it|unknown workspace|NOT shown/i);
    expect(out, '必须给出归属计数').toContain('HXLoLi-Music x1');
    expect(out, '### 红线: 别的项目的正文一个字都不能出现').not.toContain('魔改');
  });

  it('范围已知但确实没有 ⇒ 也走原话档 (两种情况不能混为一谈)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hxmem-empty3-'));
    const stack = openMemoryStack(root, { embedder: null });
    try {
      await stack.store.add({ id: 'b1', kind: 'fact', scope: 'project', project: 'other', source: 't', ts: T, content: '别的项目的条款 alpha' } as never);
    } finally { stack.close(); }
    const out = await search(root, () => ({ project: 'mine', lineage: ['mine'] }), 'alpha 条款');
    // 有候选 (别项目), 因此走第二档  但**必须标出它不属于本工作区**, 且不带正文。
    expect(out).not.toContain('No relevant memory found.');
    expect(out).toMatch(/outside it/);
    expect(out, '别项目的正文不得出现').not.toContain('alpha 条款');
  });
});
