// src/adapters/dsh/client/settings-scope.ts — 宿主 settingsScope 的最小结构契约 (纯类型)。
//
// 为什么把类型单独放一个 .ts: 卡片是 .tsx, 而 node 环境的测试要 import 这些类型/纯逻辑时
// 不能顺手把 JSX 组件树拖进 kernel 的 tsc 程序 (那份 tsconfig 没有 DOM lib)。
// 这里只取本插件用到的四个方法 —— 宿主真实返回面更宽, 但我们只依赖这四点。
/** settingsScope 快照: 值 + 用户层 + 可写性。 */
export interface SettingsSnapshotLike {
  status?: string;
  value?: unknown;
  user?: unknown;
  revision?: number;
  writable?: boolean;
}

/** 宿主 settingsScope.bind() 的返回面 (本插件用到的四个方法)。 */
export interface SettingsScopeLike {
  getSnapshot(): SettingsSnapshotLike;
  subscribe(listener: () => void): () => void;
  set(field: string, value: unknown): Promise<void>;
  unset(field: string): Promise<void>;
}
