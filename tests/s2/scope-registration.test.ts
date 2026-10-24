// tests/s2/scope-registration.test.ts — 「工作区范围必须从**一定会跑的路径**登记」的回归。
//
// 为什么需要它 (2026-10-06 用户实测 + 只读审计双重取证):
// `HxMemoryRuntime.lastProject/lastLineage` 此前**只有** `onSessionStart` 一个写入点,
// 而它依赖宿主事件 (`agent/created` / `agent/session-start`)。解压 2026-09-29~10-06 的
// 会话流水枚举 type, 这两个事件名**一次都没出现过**  于是 scope 恒为 undefined,
// 而 `memory_search` 固定传 `scopeRequired: true` ⇒ 1160/1273 条项目内记忆被整批排除。
// 实测后果: 24 次主线程检索里 13 次返回 "No relevant memory found.", 其中 13/13 在库里
// **都有字面命中**; 最刺眼的一次是 memory_save 成功返回后 **8 秒**再查同样得空。
//
// 修法不是再赌一个事件名, 而是从 `agent/pre-step` 这条**每步都跑**的路径上登记: 它手里
// 有完整 session (含 cwd), 且与注入侧共用同一个 `scopeOfSession`  两个入口从此同源。
//
// ⚠ 本文件的第一条用例是**负例**: 它证明"只靠会话事件"这条路在事件缺失时确实失效。
// 这是那个缺陷的形态, 必须被钉住, 否则下一个人会以为"只要注册了事件就没事了"。
import { describe, expect, it } from 'vitest';
import { HxMemoryRuntime } from '../../src/adapters/dsh/runtime.ts';
import { scopeOfSession } from '../../src/adapters/dsh/session-scope.ts';

/** 最小可用的 runtime 桩: 只测 scope 记账, 不碰捕获管线。 */
function makeRuntime(): { remember: (s: unknown) => void; scope: () => unknown } {
  const rt = Object.create(HxMemoryRuntime.prototype) as Record<string, unknown>;
  // 只初始化 scope 相关字段 (其余字段本用例不触碰)。
  rt.lastProject = undefined;
  rt.lastLineage = [];
  return {
    remember: (s: unknown) => (rt.rememberScope as (x: unknown) => void)(s),
    scope: () => (rt.scope as () => unknown).call(rt),
  };
}

/** 一个只有 header.cwd 的会话 (projectOfSession/lineageOfSession 只要这个)。 */
function sessionAt(cwd: string) {
  return { id: 's1', header: { cwd, origin: 'main' } };
}

describe('工作区范围登记 (scope 恒空的回归)', () => {
  it('### 负例: 没有登记过 ⇒ scope 是 undefined (这就是那 13 次空手的成因形态)', () => {
    const r = makeRuntime();
    expect(r.scope(), '没登记过就必须是 undefined, 而不是"全都给"').toBeUndefined();
  });

  it('rememberScope 之后 scope 立刻可用 (预步路径每步都会走到这里)', () => {
    const r = makeRuntime();
    r.remember({ project: 'HXLoLi-Music', lineage: ['HXLoLi-Music'] });
    expect(r.scope()).toEqual({ project: 'HXLoLi-Music', lineage: ['HXLoLi-Music'] });
  });

  it('重复登记同一条链不改变结果 (每步都调, 必须幂等)', () => {
    const r = makeRuntime();
    const scope = { project: 'a', lineage: ['a', 'root'] };
    r.remember(scope);
    r.remember(scope);
    r.remember(scope);
    expect(r.scope()).toEqual({ project: 'a', lineage: ['a', 'root'] });
  });

  it('undefined / 空对象不污染已有范围 (不给就等于没说话)', () => {
    const r = makeRuntime();
    r.remember({ project: 'a', lineage: ['a'] });
    r.remember(undefined);
    r.remember({});
    expect(r.scope()).toEqual({ project: 'a', lineage: ['a'] });
  });

  it('从真实会话对象算出的范围与 scopeOfSession 逐字一致 (两入口同源)', () => {
    const sess = sessionAt(process.cwd());
    const derived = scopeOfSession(sess as never);
    const r = makeRuntime();
    if (derived && typeof derived === 'object') r.remember(derived);
    // 本仓目录一定在一个 git 仓库里 ⇒ derived 不该是 undefined。
    expect(derived, 'cwd 在仓库内时 scopeOfSession 必须给出范围').toBeDefined();
    expect(r.scope()).toEqual(derived);
  });
});
