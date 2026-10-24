// tests/s2/negative-lesson-context.test.ts — 教训必须从**全量上下文**提炼, 不是套模板。
//
// ## 用户实测 (2026-10-06)
//
// 原话一: "我骂你的时候显然不会直接告诉你答案呐, 你肯定不能根据我骂你的那时候的输出啊,"
//          "肯定要看你的上下文呐, 你不包含上下文, 那你沉淀个屁呀"。
// 原话二: "要有全量上下文呐, 反正这样子都能获取到缓存的。你难道不知道缓存是基于前缀的吗?"
//
// 两句话定下两条设计 (见 capture/transcript.ts 头注):
//   1. 给**全量**, 不是最近一轮  骂声说的是"你刚才那一串都在乱搞";
//   2. 顺序按真实对话流排  缓存按前缀复用, 截断式的"取最近 N 条"会让前缀全废。
//
// 本文件钉住四件事:
//   ① 提炼器**必须收到**全量上下文;
//   ② 上下文**按对话流顺序** (user/assistant 交错, 时间升序);
//   ③ 提炼器结论**覆盖**模板正文; 不可用时**退回模板** (缺 AI 不等于一条不落);
//   ④ 非负面轮次**不传** transcript (这条路径不许扩散)。
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMemoryStack } from '../../src/app/stack.ts';
import { CapturePipeline } from '../../src/capture/pipeline.ts';
import { buildTranscript, transcriptItemsOf } from '../../src/capture/transcript.ts';
import { compileNegativity, detectNegative, lessonDraftOf } from '../../src/kernel/negativity.ts';
import type { TurnStructurer, StructuredTurn } from '../../src/capture/structurer.ts';

const compiled = compileNegativity();
const negativity = {
  detect: (t: string) => detectNegative(t, compiled),
  lessonDraft: (s: Parameters<typeof lessonDraftOf>[0], t: string) => lessonDraftOf(s, t, compiled),
};

const EPISODES = [
  { session: 's1', role: 'user', text: '把设置页的布局改一下', at: '2026-10-06T01:00:00Z' },
  { session: 's1', role: 'assistant', text: '我按自己的理解重写了整个设置页', at: '2026-10-06T01:00:01Z' },
  { session: 's1', role: 'user', text: '你他妈傻逼吧，停', at: '2026-10-06T01:00:02Z' },
];
const TRANSCRIPT = buildTranscript(transcriptItemsOf(EPISODES, 's1'));

function spyStructurer(conclusion?: string) {
  const calls: Array<Record<string, unknown>> = [];
  const impl: TurnStructurer = {
    canConclude: true,
    async structure(input) {
      calls.push(input as Record<string, unknown>);
      const out: StructuredTurn = { summary: 's', tags: [], points: [] };
      if (conclusion) out.conclusion = conclusion;
      return out;
    },
  };
  return { calls, impl };
}

async function run(structurer: TurnStructurer, opts: { withTranscript?: boolean; text?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'hxmem-negctx-'));
  const stack = openMemoryStack(root, { episodeRetentionDays: 0, embedder: null });
  try {
    const pipe = new CapturePipeline(stack.store, {
      reviewRoot: root,
      structurer,
      ...(opts.withTranscript === false ? {} : { transcriptFor: () => TRANSCRIPT }),
    });
    const res = await pipe.run(
      {
        session: 's1',
        turn: 1,
        project: 'P',
        text: opts.text ?? '你他妈傻逼吧，停',
        answer: '我按自己的理解重写了整个设置页',
      } as never,
      { negativity } as never,
    );
    return res as { entries: Array<{ content: string }> };
  } finally { stack.close(); rmSync(root, { recursive: true, force: true }); }
}

describe('transcript 本身', () => {
  it('按对话流顺序 (user/assistant 交错, 时间升序), 且与 session 对齐', () => {
    const other = [...EPISODES, { session: 's2', role: 'user', text: '别的会话', at: '2026-10-06T00:00:00Z' }];
    const out = transcriptItemsOf(other, 's1');
    expect(out.map((i) => i.role)).toEqual(['user', 'assistant', 'user']);
    expect(out.map((i) => i.text)).not.toContain('别的会话');
  });

  it('### 预算内**不截断**  这是前缀能复用的前提', () => {
    const whole = buildTranscript(transcriptItemsOf(EPISODES, 's1'));
    expect(whole).toContain('把设置页的布局改一下');
    expect(whole, '不许加\"已省略\"标记').not.toContain('已省略');
  });

  it('### 超预算时从最早丢并**显式声明**, 不许默默截断', () => {
    const out = buildTranscript(transcriptItemsOf(EPISODES, 's1'), { budgetChars: 30 });
    expect(out).toContain('开头已省略');
    expect(out).toContain('你他妈傻逼吧，停');
  });
});

describe('负面轮次的教训由全量上下文提炼', () => {
  it('### 提炼器必须收到全量上下文 (缺它 = 用户明确否决的做法)', async () => {
    const spy = spyStructurer('禁止重写整个设置页。改为: 先确认要改哪一处再动手。');
    await run(spy.impl);
    const call = spy.calls[0]!;
    expect(call.transcript, '必须是整段上下文, 而不是只有那句批评').toBe(TRANSCRIPT);
    expect(String(call.transcript)).toContain('我按自己的理解重写了整个设置页');
  });

  it('### 提炼器的结论必须覆盖模板正文', async () => {
    const real = '禁止重写整个设置页。改为: 先确认要改哪一处再动手。';
    const res = await run(spyStructurer(real).impl);
    expect(res.entries[0]!.content).toContain('先确认要改哪一处');
    expect(res.entries[0]!.content, '不该退回泛泛的行为禁令').not.toContain('卡住立刻换路径');
  });

  it('没有 transcript 时退回模板 (缺 AI/缺上下文都不等于一条不落)', async () => {
    const res = await run(spyStructurer(undefined).impl);
    expect(res.entries.length).toBe(1);
  });

  it('非负面轮次不传 transcript (不许把这条路径扩散到所有轮次)', async () => {
    const spy = spyStructurer('某条普通结论');
    await run(spy.impl, { text: '把缓存过期设成 60 秒' });
    for (const call of spy.calls) expect(call.transcript, '普通轮次不该带 transcript').toBeUndefined();
  });
});
