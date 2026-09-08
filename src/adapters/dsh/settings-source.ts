// src/adapters/dsh/settings-source.ts — 宿主权威设置源的持有者。
//
// 为什么单独一层: 宿主 ctx.settings.installSection(owner, ns, schema, entry, hooks) 的
// hooks.setSource(current) 会把"当前权威配置"的 **thunk** 交给消费方。消费方必须把它存下来
// 并在每次读取时调用 —— 只接住一次快照 (或干脆忽略) 会让面板里改的设置永远不生效
// (真实踩过: setSource: () => void 0)。这个类把该约定固化成可测的小对象。

export interface SettingsSource<T> {
  /** 读当前权威配置 (未接住宿主时返回组合配置)。 */
  read(): Partial<T>;
  /** 接住宿主给的 thunk (每次读取都重新求值)。 */
  adopt(current: () => T): void;
  /** 是否已经接住宿主。 */
  readonly adopted: boolean;
}

export function createSettingsSource<T extends object>(composition: T): SettingsSource<T> {
  let source: () => Partial<T> = () => composition;
  let adopted = false;
  return {
    read: () => source(),
    adopt(current) {
      if (typeof current !== "function") {
        throw new TypeError("settings source: setSource expects a thunk");
      }
      source = () => current();
      adopted = true;
    },
    get adopted() {
      return adopted;
    },
  };
}
