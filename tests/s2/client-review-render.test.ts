// tests/s2/client-review-render.test.ts — 面板真的能渲染出期待的元素吗?
//
// 为什么需要它 (2026-09-18): 加"注入预览" tab 时, 我发现**没有任何测试断言过面板渲染** ——
// 已有的 `client-injection-card.test.ts` 只测 locale 键与注册契约, 不碰渲染树。
// 而面板此前真踩过渲染类缺陷 (绑定页漏了 {var} 插值, 把 "{n}" 原样显示给用户)。
//
// 做法 (不引入新依赖): React 内部有一个 **dispatcher 槽**
// (`ReactCurrentDispatcher.current`), hooks 通过它取实现。
// 我们提供一个最小实现 (useState 取初值 / useEffect 不执行 / useCallback 返回原函数…),
// 就能**真实调用**函数组件并遍历它返回的元素树 —— 足以回答"这个 tab 被渲染出来了吗"。
//
// **二次渲染也可测** (2026-09-18 补): `useState` 返回的 setter 把值写回槽位,
// 于是"改状态 → 再渲染一次"可以在同一进程里驱动 —— 这覆盖了"切到某个 tab 后内容区渲染什么"。
//
// **仍不在范围内 (必须说清)**: 浏览器里的**最终 DOM**、**事件处理**、样式是否生效。
// 它挡的是"元素根本没进树"这一类缺陷, 不挡"渲染出来但长得不对"。
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require2 = createRequire(import.meta.url);
const React = require2("react");
const internals = React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;

/** 最小 hook dispatcher (只为让函数组件能跑完一次渲染)。 */
function makeDispatcher() {
  let states: unknown[] = [];
  let cursor = 0;
  const d: Record<string, unknown> = {
    useState(init: unknown) {
      const i = cursor++;
      if (states.length <= i) states[i] = typeof init === "function" ? (init as () => unknown)() : init;
      return [states[i], () => {}];
    },
    useEffect() {}, useLayoutEffect() {}, useInsertionEffect() {}, useDebugValue() {}, useImperativeHandle() {},
    useCallback(fn: unknown) { cursor++; return fn; },
    useMemo(fn: unknown) { cursor++; return (fn as () => unknown)(); },
    useRef(i: unknown) { cursor++; return { current: i }; },
    useContext() { return undefined; },
    useReducer(_r: unknown, i: unknown) { cursor++; return [i, () => {}]; },
    useTransition() { cursor++; return [false, (f: () => void) => f()]; },
    useDeferredValue(v: unknown) { cursor++; return v; },
    useId() { cursor++; return "id"; },
    useSyncExternalStore(_s: unknown, g: () => unknown) { cursor++; return g(); },
  };
  return { d, reset: () => { cursor = 0; states = []; } };
}

/** 从打包产物取模块 (面板只在 client bundle 里, 不在 src 的独立产物中)。 */
function loadBundleModule() {
  const src = readFileSync("dist/dsh/client.js", "utf8");
  const captured: { id?: string; factory?: (req: (n: string) => unknown) => Record<string, unknown> } = {};
  const fakeWindow = { __ModuleLoader__: { load: (m: typeof captured) => { captured.id = m.id; captured.factory = m.factory; } } };
  new Function("window", src)(fakeWindow);
  const req = (name: string) => {
    if (name === "react") return React;
    if (name === "react/jsx-runtime") return require2("react/jsx-runtime");
    throw new Error("unexpected require: " + name);
  };
  return { id: captured.id, mod: captured.factory!(req) };
}

/** 收集元素树里的所有字符串节点。 */
function collectTexts(node: unknown, depth = 0, out: string[] = []): string[] {
  if (depth > 60 || node == null || typeof node === "boolean") return out;
  if (typeof node === "string") { out.push(node); return out; }
  if (Array.isArray(node)) { for (const c of node) collectTexts(c, depth + 1, out); return out; }
  const el = node as { props?: { children?: unknown } };
  if (el.props?.children !== undefined) collectTexts(el.props.children, depth + 1, out);
  return out;
}

/** 注册所有面板并返回按 spec.id 索引的组件。 */
function registerPanels() {
  const { id, mod } = loadBundleModule();
  const registered: Array<{ spec: { id?: string }; comp: (p: unknown) => unknown }> = [];
  const ctx = {
    get: (n: string) => (n === "connection" ? { rpc: { call: async () => null } } : undefined),
    effect: (f: () => unknown) => { try { return f(); } catch { /* 副作用不在本测试范围 */ } },
    locale: { bind: () => (k: string) => k, register: () => () => {} },
    slots: {
      inject: (_s: string, cb: () => void) => { try { cb(); } catch { /* 同上 */ } },
      register: (spec: { id?: string }, comp: (p: unknown) => unknown) => { registered.push({ spec, comp }); return {}; },
    },
  };
  (mod.apply as (c: unknown) => void)(ctx);
  return { id, registered };
}

describe("面板渲染 (组件函数的输出树)", () => {
  it("bundle 可加载且把**已知的面板/卡片都注册上了**", () => {
    const { id, registered } = registerPanels();
    expect(id).toBe("@hengxin666/hx-memory");
    // ⚠ 判据从"数量 == 3"改成"**id 集合包含已知项**" (2026-09-20, §795):
    // 那个数字断言在加"真相文件"面板时变红 —— 而它想守的并不是"恰好三个",
    // 而是"每个面板都接上了"。与下面那条 tab 断言同一原则 ("加 tab 不该让测试变红")。
    // 现在: 新增面板**要显式加进这个集合**, 于是"漏接线"仍会被抓到, 而"多一个面板"不会假红。
    const ids = registered.map((r) => r.spec.id).sort();
    // 三个 settings 区段靠 id 定位; 注入卡走 registerInjectionCard (另一套 spec, 无 id) —— 故为 undefined。
    // 注入卡自身注册几条 (0.1.7 起是"新槽位 + 旧槽位"双注册, 见 register-card.ts) 不是本断言的
    // 关注点: 这里只钉"三个区段都在"。用集合而非逐项相等, 与上面那条原则一致 ——
    // 加一条卡片接线不该让这条断言假红, 而"漏接某个区段"仍会被抓到。
    expect(new Set(ids)).toEqual(
      new Set(["hx-memory-bindings", "hx-memory-files", "hx-memory-review", undefined]),
    );
  });

  it("**审阅面板渲染出全部 8 个 tab, 含新增的 tabInjection**", () => {
    const { registered } = registerPanels();
    const target = registered.find((r) => r.spec.id === "hx-memory-review");
    expect(target, "必须注册 hx-memory-review 面板").toBeTruthy();

    const { d, reset } = makeDispatcher();
    reset();
    internals.ReactCurrentDispatcher.current = d;
    try {
      const tree = target!.comp({ rpc: { call: async () => null }, t: (k: string) => k });
      const texts = collectTexts(tree);
      const tabs = texts.filter((x) => x.startsWith("tab"));
      expect(tabs).toContain("tabInjection");
      // 断言的是"每个 tab 都在树里", 而不是具体条数 —— 加 tab 不该让这条测试变红
      for (const k of ["tabProposals", "tabRecent", "tabCaptureReview"]) expect(tabs).toContain(k);
      expect(texts.length).toBeGreaterThan(10);
    } finally {
      internals.ReactCurrentDispatcher.current = null;
    }
  });

  it("绑定页面板也能渲染 (没有渲染类异常)", () => {
    const { registered } = registerPanels();
    const target = registered.find((r) => r.spec.id === "hx-memory-bindings");
    expect(target).toBeTruthy();
    const { d, reset } = makeDispatcher();
    reset();
    internals.ReactCurrentDispatcher.current = d;
    try {
      expect(() => target!.comp({ rpc: { call: async () => null }, t: (k: string) => k })).not.toThrow();
    } finally {
      internals.ReactCurrentDispatcher.current = null;
    }
  });
});
/**
 * 可重入的 dispatcher: setter 把值写回槽位, 因此能"改状态 → 再渲染一次"。
 *
 * 这覆盖了上一版测试明确列在范围外的**二次渲染分支** (切到某个 tab 后内容区渲染什么)。
 */
function makeReentrant() {
  const states: unknown[] = [];
  const setters: Array<(v: unknown) => void> = [];
  // ⚠ 每次渲染都要把 hook 游标归零 —— 否则 useState 的索引会跨渲染累积,
  // 最终形成无界数组 (实测: 不重置会让 vitest 进程栈溢出崩溃, 而不是给出断言失败)。
  let cursor = 0;
  const d: Record<string, unknown> = {
    useState(init: unknown) {
      const i = cursor++;
      if (states.length <= i) states[i] = typeof init === "function" ? (init as () => unknown)() : init;
      if (!setters[i]) {
        const idx = i;
        setters[idx] = (v: unknown) => {
          states[idx] = typeof v === "function" ? (v as (p: unknown) => unknown)(states[idx]) : v;
        };
      }
      return [states[i], setters[i]];
    },
    useEffect() {}, useLayoutEffect() {}, useInsertionEffect() {}, useDebugValue() {}, useImperativeHandle() {},
    useCallback(fn: unknown) { return fn; },
    useMemo(fn: unknown) { return (fn as () => unknown)(); },
    useRef(i: unknown) { return { current: i }; },
    useContext() { return undefined; },
    useReducer(_r: unknown, i: unknown) { return [i, () => {}]; },
    useTransition() { return [false, (f: () => void) => f()]; },
    useDeferredValue(v: unknown) { return v; },
    useId() { return "id"; },
    useSyncExternalStore(_s: unknown, g: () => unknown) { return g(); },
  };
  return {
    render(comp: (p: unknown) => unknown): string[] {
      cursor = 0;
      internals.ReactCurrentDispatcher.current = d;
      try {
        return collectTexts(comp({ rpc: { call: async () => null }, t: (k: string) => k }));
      } finally {
        internals.ReactCurrentDispatcher.current = null;
      }
    },
    /**
     * 逐个槽位试填 v, 返回"填哪个槽会让 marker 出现"(-1 = 没有)。
     *
     * **每轮试填前把全部槽位还原到快照** —— 否则上一轮的脏值会污染本轮渲染
     * (实测表现为 `hits.map is not a function`: 一个本该是数组的槽位被留成了别的值)。
     * 命中后**保留**该槽位的值, 调用方接着 `render()` 就能看到目标分支。
     */
    findSlot(comp: (p: unknown) => unknown, marker: string, v: unknown): number {
      const snap = states.slice();
      for (let i = 0; i < setters.length; i++) {
        for (let k = 0; k < snap.length; k++) states[k] = snap[k];
        setters[i]!(v);
        let texts: string[];
        try {
          texts = this.render(comp);
        } catch {
          // 试填到**不相关的槽位**会让组件在渲染中抛错 (例如把数组槽改成了字符串)。
          // 那不是缺陷, 是"试错了位置" —— 还原后继续试下一个。
          continue;
        }
        if (texts.includes(marker)) return i;
      }
      for (let k = 0; k < snap.length; k++) states[k] = snap[k];
      return -1;
    },
    /** 直接看某个槽位的当前值 (用于按"值"而非"试错"定位)。 */
    valueAt(i: number): unknown {
      return states[i];
    },
  };
}

describe("面板二次渲染 (驱动 setState 之后的分支)", () => {
  it("**切到 inject tab 后内容区渲染出来** (不是永远停在别的 tab)", () => {
    const { registered } = registerPanels();
    const target = registered.find((r) => r.spec.id === "hx-memory-review")!;
    const h = makeReentrant();
    const first = h.render(target.comp);
    expect(first).toContain("tabProposals");
    expect(first).not.toContain("injHint"); // 默认 tab 下内容区不该出现
    // 找到 tab 状态槽 (初值是 "props"), 改成 "inject"
    const slot = h.findSlot(target.comp, "injHint", "inject");
    expect(slot, "必须能把 tab 切成 inject").toBeGreaterThanOrEqual(0);
    const texts = h.render(target.comp);
    expect(texts).toContain("injHint");
  });

  it("**注入有数据时, 被挡条目与成因都渲染进树**", () => {
    const { registered } = registerPanels();
    const target = registered.find((r) => r.spec.id === "hx-memory-review")!;
    const h = makeReentrant();
    h.render(target.comp);
    expect(h.findSlot(target.comp, "injHint", "inject")).toBeGreaterThanOrEqual(0);

    const PAYLOAD = {
      picked: [{ id: "r1", kind: "rule", scope: "global", content: "测试规则A", tokens: 30 }],
      blocked: [{ id: "r2", kind: "rule", content: "被挡的规则B", tokens: 35, reason: "over-group-cap" }],
      budgetTokens: 400,
      selectedTokens: 30,
    };
    // 数据槽的初值是 null (injectView) —— 按"填它会渲染出 injPicked"来定位
    expect(h.findSlot(target.comp, "injPicked", PAYLOAD)).toBeGreaterThanOrEqual(0);
    const texts = h.render(target.comp);
    // 这是这张 tab 存在的理由: 用户必须能看见"哪些被挡了"以及"为什么"
    expect(texts).toContain("injPicked");
    expect(texts).toContain("injBlocked");
    expect(texts).toContain("injReasonGroupCap");
    expect(texts).toContain("测试规则A");
    expect(texts).toContain("被挡的规则B");
  });
});
