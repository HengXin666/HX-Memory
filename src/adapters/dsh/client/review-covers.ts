// src/adapters/dsh/client/review-covers.ts — 队列视图 `covers` 的**归一化** (纯逻辑, 无 JSX/DOM)。
//
// 为什么必须有这一层 (真实故障): 客户端插件包与宿主进程是**两份产物** ——
// 宿主启动时把 dist 读进内存, 而面板每次刷新页面都从磁盘重新加载。只重建 dist 不重启宿主时,
// 面板会拿到**旧宿主**返回的视图: 那里 `covers` 是**计数 (number)**, 而不是 id 列表。
// 面板直接 `p.covers.slice(...)` 就会抛 `TypeError: p.covers.slice is not a function`
// (实测发生), 用户看到的是"取不回被覆盖的条目", 完全指不出真正原因。
//
// 归一化把"宿主比面板旧"变成**可显示的状态**而不是异常: 不假装能展开 (旧宿主没有按 id 取
// 原文的出口), 也不静默显示空白 —— 空白会被读成"这条提议没有实例", 那是另一种谎言。
// 与 injection-mode.ts 同一手法: 纯判定留在 .ts 里, node 环境的测试可以直接断言。
//
// 版本不一致是**部署状态**, 不是数据问题: 正确处置是重启宿主, 不是让面板去兼容旧契约。
import type { HxMemoryRpcCaller } from "./rpc.js";

/** 面板对 `covers` 的三种可能输入 (新宿主 / 旧宿主 / 坏数据) 归一化后的结果。 */
export interface CoversView {
  /** 可展开的实例 id。旧宿主给不出 → 空数组。 */
  ids: string[];
  /** 宿主回的是**计数**而不是 id 列表 → 面板与宿主版本不一致 (重启宿主才会好)。 */
  legacy: boolean;
  /** 展示用的条数: 新宿主 = ids.length, 旧宿主 = 那个计数本身。 */
  count: number;
}

/**
 * 读一条提议的 covers。
 *
 * 只接受两种合法形态: id 数组 (新宿主) 与数字 (旧宿主)。其余 (null/字符串/对象) 一律按
 * "取不到依据"处理 —— 面板参数不可信是既有约定, 这条数据同样来自宿主而不是用户。
 */
export function readCovers(raw: unknown): CoversView {
  if (Array.isArray(raw)) {
    const ids = raw.filter((id): id is string => typeof id === "string" && id.length > 0);
    return { ids, legacy: false, count: ids.length };
  }
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
    // 旧宿主: 只有计数, 没有 id —— 因此"看依据"这件事在旧宿主上做不到。
    return { ids: [], legacy: true, count: Math.floor(raw) };
  }
  return { ids: [], legacy: false, count: 0 };
}

/**
 * 宿主不认识新出口时的判定 (面板比宿主新)。
 *
 * 两种表现都要算: 客户端校验抛的 "unknown remote method" (名字不在**面板**的表里) 与
 * 宿主路由回的错误 (名字在面板表里但宿主没这个 endpoint —— 实测宿主回的是
 * "method not implemented")。后者措辞随宿主版本变化, 因此只认"方法不存在"这一类词,
 * 不认具体句式; 判据过窄会让"面板比宿主新"退化成一条普通的加载失败。
 */
export function isStaleHostError(error: unknown): boolean {
  const text = String((error as { message?: string })?.message ?? error);
  return /unknown remote method|not a function|unimplemented|not implemented|no such|not found|404/i.test(
    text,
  );
}

/** 展开一条提议需要的那次调用 (单独成函数: 面板只关心"拿到什么"). */
export async function fetchCovers(
  rpc: HxMemoryRpcCaller,
  ids: string[],
  call: (rpc: HxMemoryRpcCaller, method: "entriesByIds", args: Record<string, unknown>) => Promise<unknown>,
): Promise<unknown[]> {
  // 空列表不发请求: 旧宿主上这个调用必然失败, 而失败的原因是"没有依据可看", 不是错误。
  if (ids.length === 0) return [];
  const rows = await call(rpc, "entriesByIds", { ids: ids.slice(0, 100) });
  return Array.isArray(rows) ? rows : [];
}
