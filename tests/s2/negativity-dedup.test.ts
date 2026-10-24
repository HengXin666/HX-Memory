// tests/s2/negativity-dedup.test.ts — 负面轮次不能因为"正文是模板"而被去重吞掉。
//
// ## 这个缺陷的形态 (2026-10-06 用户实测: "为什么我辱骂你的时候, 那些记忆从来就没有写入进去")
//
// 链路本来是通的: 词表能判出负面信号 (实测 104 个"被骂且有实质回答"的轮次里 103 个判出),
// 闸门也放行 (`bypassContext = negative.hit`)。真正丢掉它们的是**最后一步的内容指纹**:
//
//   1. 负面轮次的正文来自 `lessonDraftOf`, 而它在抽不出方向时退到按类别的**行为禁令** 
//      `BEHAVIOR_BANS` 只有 3 条固定句子 (blame-method / blame-execution / correction 各一条)。
//      实测: 8 句措辞完全不同的辱骂, 产出**逐字相同**的 62 字正文。
//   2. 指纹只算正文 ⇒ 第 2 条起 hash 全等 ⇒ `existingHashes.has(hash)` 为真 ⇒ 判重丢弃。
//
// 实测复现 (修复前): 11 次被骂、措辞全不同 → 落盘 1 条、去重吞掉 9 条。
// 一个真实账本记录作为旁证: 本会话 turn 1 的 capture 明细就是 `duplicate:3cc62c66dd8b03fc`,
// 而 `3cc62c66dd8b03fc` 正是 blame-execution 模板的 sha256 前 16 位。
//
// ## 修法 (两处, 缺一不可)
//   · 正文加**证据行** `(起因: <脱敏原话>)`  既让条目能自证出处, 又让不同原话天然不同 hash;
//   · 证据行必须**脱敏**: 正文里不许出现脏话是本仓既有红线 (见 negativity-capture.test.ts)。
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMemoryStack } from '../../src/app/stack.ts';
import { compileNegativity, detectNegative, lessonDraftOf } from '../../src/kernel/negativity.ts';
import { CapturePipeline } from '../../src/capture/pipeline.ts';

const compiled = compileNegativity();

const T = { validAt: '2026-10-01T00:00:00.000Z', assertedAt: '2026-10-01T00:00:00.000Z' };
const negativity = {
  detect: (t: string) => detectNegative(t, compiled),
  lessonDraft: (s: never, t: string) => lessonDraftOf(s, t, compiled),
};

/** 逐字取自真实会话的辱骂样本 (措辞刻意互不相同)。 */
const ABUSE = [
  '你他妈傻逼吧，停',
  '妈的全那个废物，而且沉淀也一点用都没有',
  '你他妈不会去往上抄吗？还在这里给我自吹自擂',
  '你傻逼吧，停',
  '你怎么就看了一处，你就你在这里断言了，你他妈傻逼吗',
  '你自己都审核不行了，你还往上交吗？你他妈的蠢驴',
  '我去你妈逼，为什么你一直在这里重复输出呢',
];

describe('负面轮次的去重行为', () => {
  it('### 负例: 模板正文必须逐字相同  这正是缺陷的成因, 钉住它以免有人以为"模板够用"', () => {
    const drafts = ABUSE.map((t) => lessonDraftOf(detectNegative(t, compiled), t, compiled));
    // 前 3 句都是 blame-execution 类, 抽不出方向 ⇒ 退到同一条行为禁令。
    expect(new Set(drafts.slice(0, 3)).size, '模板只有 3 条, 同一类必然重复').toBe(1);
  });

  it('### 措辞不同的辱骂必须各自落盘 (修复前: 11 次只留 1 条)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hxmem-negdup-'));
    const stack = openMemoryStack(root, { episodeRetentionDays: 0, embedder: null });
    try {
      const pipe = new CapturePipeline(stack.store, { reviewRoot: root });
      let stored = 0;
      for (const text of ABUSE) {
        const r = await pipe.run({ session: 's', turn: 1, project: 'P', text, answer: 'B'.repeat(300) } as never, { negativity } as never);
        stored += (r as { entries: unknown[] }).entries.length;
      }
      expect(stored, '每一句不同的批评都该留下一条教训').toBe(ABUSE.length);
    } finally { stack.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it('同一句原话复读仍去重 (不能为了修这个缺陷把去重整个关掉)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hxmem-negdup2-'));
    const stack = openMemoryStack(root, { episodeRetentionDays: 0, embedder: null });
    try {
      const pipe = new CapturePipeline(stack.store, { reviewRoot: root });
      const one = { session: 's', turn: 1, project: 'P', text: '你他妈傻逼吧，停', answer: 'B'.repeat(300) } as never;
      const a = await pipe.run(one, { negativity } as never);
      const b = await pipe.run(one, { negativity } as never);
      expect((a as { entries: unknown[] }).entries.length).toBe(1);
      expect((b as { entries: unknown[] }).entries.length, '同一句复读不该再落一条').toBe(0);
    } finally { stack.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it('落库正文里不得出现脏话 (证据行必须脱敏)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hxmem-negdup3-'));
    const stack = openMemoryStack(root, { episodeRetentionDays: 0, embedder: null });
    try {
      const pipe = new CapturePipeline(stack.store, { reviewRoot: root });
      for (const text of ABUSE) {
        const r = await pipe.run({ session: 's', turn: 1, project: 'P', text, answer: 'B'.repeat(300) } as never, { negativity } as never);
        for (const e of (r as { entries: Array<{ content: string }> }).entries) {
          for (const bad of ['傻逼', '操你', '他妈', '蠢驴']) {
            expect(e.content.includes(bad), `${text} -> ${e.content}`).toBe(false);
          }
        }
      }
    } finally { stack.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it('证据行确实进来了 (条目能自证出处, 而不是只剩一句模板)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hxmem-negdup4-'));
    const stack = openMemoryStack(root, { episodeRetentionDays: 0, embedder: null });
    try {
      const pipe = new CapturePipeline(stack.store, { reviewRoot: root });
      const r = await pipe.run({ session: 's', turn: 1, project: 'P', text: '你他妈脑子有坑嘛，想办法怎么解决这个问题', answer: 'B'.repeat(300) } as never, { negativity } as never);
      const first = (r as { entries: Array<{ content: string }> }).entries[0]!;
      expect(first.content).toContain('起因:');
      expect(first.content, '诉求那半句必须留下').toContain('想办法怎么解决这个问题');
    } finally { stack.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it('同一类模板 + 不同原话 ⇒ 正文不同 (这就是 hash 不再相撞的原因)', () => {
    const a = lessonDraftOf(detectNegative('你他妈傻逼吧，停', compiled), '你他妈傻逼吧，停', compiled);
    const b = lessonDraftOf(detectNegative('妈的全那个废物', compiled), '妈的全那个废物', compiled);
    expect(a, '模板本身相同 (负例已钉住)').toBe(b);
  });
});
