// tests/s2/scope-per-call.test.ts — 工具检索的范围必须**按调用**取, 不能按进程快照。
//
// 为什么需要它 (2026-10-06 实测, 我自己引入的缺陷): 为了让 `memory_search` 拿得到工作区,
// 我给 runtime 加了"预步每步登记"。那在一个会话里是对的, 但 **DSH 是一个进程跑多个会话**
// (桌面端 + 子代理 + 多窗口共用同一 runtime 实例)  后启动的会话会把 lastProject 改写掉,
// 前一个会话的工具调用就按**别人的工作区**过滤。
//
// 实证 (就在写这段注释的那一轮): 会话 cwd 是 `components/HX-Memory`, 而 `memory_search`
// 返回的四条命中 project 全是 `freebuff-proxy`。这不是"搜到别人的项目", 而是**按别人的项目搜** 
// 比原来的空手更隐蔽 (它有结果, 只是全错)。
//
// 判据: `exec.agent` 是**按调用**传进来的 (dsh-tools 的 ToolExecContext.agent), 它带 session.cwd,
// 因此优先于进程级快照; 缺失时才退回快照 (无宿主的测试与老调用点行为不变)。
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

/** 造一个带 cwd 的 agent (工具调用的第三个参数就是它)。 */
function agentAt(cwd: string) {
  return { session: { id: 'sess-x', header: { id: 'sess-x', cwd, origin: 'main' } } };
}

describe('memory_search 的范围按调用取 (多会话同进程的串扰回归)', () => {
  it('### 负例: 进程快照是别的项目时, 以本调用的 agent 为准', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hxmem-percall-'));
    const stack = openMemoryStack(root, { embedder: null });
    try {
      await stack.store.add({ id: 'mine', kind: 'decision', scope: 'project', project: 'HX-Memory', source: 't', ts: T, content: '本项目决定用 SQLite 存真相 mine-marker' } as never);
      await stack.store.add({ id: 'theirs', kind: 'decision', scope: 'project', project: 'freebuff-proxy', source: 't', ts: T, content: '别的项目决定用 Postgres 存真相 theirs-marker' } as never);

      const tools = new Map<string, { execute: (a: unknown, e: unknown) => Promise<string> }>();
      registerMemoryTools(makeCtx(tools), {
        store: stack.store,
        generalizer: { propose: async () => ({}) } as never,
        facade: stack.facade,
        // 进程快照指向**别的项目** (模拟: 另一个会话刚跑过预步把 lastProject 顶掉了)。
        scopeOf: () => ({ project: 'freebuff-proxy', lineage: ['freebuff-proxy'] }),
      });

      const search = tools.get('memory_search')!;
      // 本调用的 agent 的 cwd 指向本仓 (project 键 = HX-Memory)。
      const out = await search.execute({ query: '决定用什么 存真相', limit: 10 }, { agent: agentAt(process.cwd()) } as never);

      expect(out, '按本调用的 agent 取范围 ⇒ 必须看到本项目条目').toContain('mine-marker');
      expect(out, '### 不得按进程快照去搜别的项目').not.toContain('theirs-marker');
    } finally {
      stack.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('没有 agent 时退回进程快照 (老调用点与测试的行为不变)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hxmem-percall2-'));
    const stack = openMemoryStack(root, { embedder: null });
    try {
      await stack.store.add({ id: 'theirs', kind: 'decision', scope: 'project', project: 'freebuff-proxy', source: 't', ts: T, content: '别的项目决定用 Postgres 存真相 theirs-marker' } as never);
      const tools = new Map<string, { execute: (a: unknown, e: unknown) => Promise<string> }>();
      registerMemoryTools(makeCtx(tools), {
        store: stack.store,
        generalizer: { propose: async () => ({}) } as never,
        facade: stack.facade,
        scopeOf: () => ({ project: 'freebuff-proxy', lineage: ['freebuff-proxy'] }),
      });
      const out = await tools.get('memory_search')!.execute({ query: '决定用什么 存真相', limit: 10 }, {} as never);
      expect(out, '退回快照后仍按快照范围给结果').toContain('theirs-marker');
    } finally {
      stack.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
