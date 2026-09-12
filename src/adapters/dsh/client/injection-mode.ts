// src/adapters/dsh/client/injection-mode.ts — 「记忆注入」设置卡的纯逻辑 (无 JSX, 无 DOM)。
//
// 为什么与卡片分开: 宿主的设置卡是 .tsx, 而仓库的 kernel tsconfig 不含 DOM lib ——
// 只要有一个 node 环境的测试 import 到 .tsx, 整棵客户端组件树就会被拉进 kernel 类型检查,
// 报一堆 "Cannot find name 'document'" (本仓库真实踩过)。纯判定留在 .ts 里就能被直接断言。
import type { SettingsScopeLike } from "./settings-scope.js";

/** 注入时机 (与宿主 schema 的 injectMode 逐字一致)。 */
export type InjectMode = "first" | "every-turn";

/** settingsScope 快照里本卡用到的字段 (未加载完时 value 可能缺失)。 */
export interface InjectionSnapshot {
  status?: string;
  value?: { injectMode?: string } | undefined;
  writable?: boolean;
}

/**
 * 读当前模式。
 *
 * 未加载/未知取值一律按 every-turn 显示: 面板谎报 "first" 会让用户以为开关已经生效,
 * 而实际上什么都没变 —— 显示保守值是唯一不会误导的方向。
 */
export function modeOf(snap: InjectionSnapshot): InjectMode {
  return snap.value?.injectMode === "first" ? "first" : "every-turn";
}

/**
 * 判定一次写入是否真的落地。
 *
 * 宿主 settingsScope 的合同是"冲突时自行恢复并重新广播"(它 settle 不代表写成功),
 * 因此判据必须是**回调后读回的权威值**, 而不是 promise 有没有 reject。
 */
export function settledTo(scope: Pick<SettingsScopeLike, "getSnapshot">, wanted: InjectMode): boolean {
  return modeOf(scope.getSnapshot() as InjectionSnapshot) === wanted;
}
