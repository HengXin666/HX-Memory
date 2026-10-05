// src/adapters/dsh/client/settings-scope.ts — 宿主 settingsScope 的最小结构契约 (纯类型)。
//
// ## 两代宿主的取名差异 (2026-09-29 实测)
//
//   - <= 0.1.6: 服务 `settingsScope`, `bind({ namespace })` → 本节所说四方法作用域。
//   - 0.1.7+:   服务 `settingsScope` **被整个删除** (全仓 grep 零命中), 换成
//               `configForms.get(entryId)` → `ConfigFormController`。
//
// 好消息是**返回面同形**: 新控制器的公开方法逐字包含
// `getSnapshot()` / `subscribe()` / `set(field, value)` / `unset(field)` (另外多一个
// `mutate(ops, revision)`)。因此卡片侧的读取与写入逻辑**一行都不用改** ——
// 只有"到哪里取这个作用域"变了, 那件事收在 `resolveSettingsScope` 里。
//
// 为什么把类型与纯逻辑放在无 JSX 的 .ts 里: 仓库的 kernel tsconfig 不含 DOM lib, 只要 node
// 环境的测试 import 到 .tsx, 整棵客户端组件树就会被拉进类型检查并报 "Cannot find name
// 'document'" (本仓库真实踩过)。

/** settingsScope 快照: 值 + 用户层 + 可写性。 */
export interface SettingsSnapshotLike {
  status?: string;
  value?: unknown;
  user?: unknown;
  revision?: number;
  writable?: boolean;
}

/** 宿主设置作用域 (本插件用到的四个方法; 两代宿主的返回面在此交集上一致)。 */
export interface SettingsScopeLike {
  getSnapshot(): SettingsSnapshotLike;
  subscribe(listener: () => void): () => void;
  set(field: string, value: unknown): Promise<void>;
  unset(field: string): Promise<void>;
}
