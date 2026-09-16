// adapters/dsh/lifecycle-wiring.ts — 插件的启动预热与卸载清理 (独立成文件的两个理由)。
//
// 1. 组装根 (index.ts) 有 400 行硬上限; 生命周期这段是天然的独立职责。
// 2. **卸载顺序**是这里唯一容易写错、又最难在评审里看出来的东西:
//    关 SQLite 必须排在 flush 之后 (flush 还要写库), 而跨 effect 的卸载顺序是隐式的 ——
//    所以 flush 与 close 必须在**同一个** disposer 里按序执行。
//
// 热重载 (cordis HMR) 的语义是 dispose 旧 fiber → 再 apply() 一次, 于是:
//   - 不 close 就每轮漏一个 SQLite 句柄 + 叠加 WAL 争用, 最终 "database is locked";
//   - close 不幂等就会在反复 dispose 时抛 (node:sqlite 对已关连接会报错)。
import type { Context } from "@deepseek-ai/cordis";
import type { FileBackend } from "../../storage/file-store.js";

export interface LifecycleDeps {
  ctx: Context;
  /** 捕获管线预热 (失败不影响可用性)。返回预热条数等, 这里只关心完成。 */
  warmUp: () => unknown;
  /** 向量索引同步预热 (首次检索不建索引, 省掉约 160ms 毛刺)。 */
  warmSync: () => void;
  /** 后台维护循环 (只在空闲窗内跑, 计时器 unref 不拖住宿主退出)。 */
  loop: { start: () => void; stop: () => void };
  /** 冲刷未落盘的缓冲; 卸载时必须 await (可能含一次最长 15s 的 LLM 调用)。 */
  flushAll: () => Promise<unknown>;
  /** 存储层句柄。 */
  store: Pick<FileBackend, "close">;
  /** store 是插件自己建的才关 —— 注入进来的属于调用方 (谁创建谁关闭)。 */
  ownsStore: boolean;
}

/**
 * 注册生命周期 effect。返回 disposer 的 label 与 index.ts 既有约定一致:
 * `hx-memory.lifecycle()`。
 */
export function wireLifecycle(deps: LifecycleDeps): void {
  const { ctx, warmUp, warmSync, loop, flushAll, store, ownsStore } = deps;
  // 关闭必须幂等: HMR 会反复 dispose。
  let closed = false;
  ctx.effect(() => {
    void warmUp();
    // 预热放在**启动后台**而不是组装期同步执行 —— 插件是长期驻留的, 启动时补一次就没有
    // 首次查询毛刺; 但绝不能在 apply() 里同步做 (那会把成本转嫁成插件加载变慢, 对一次性 CLI 尤其亏)。
    // 失败静默: 检索时会自行同步, 行为不变 (只是慢一次)。
    setTimeout(() => {
      try {
        warmSync();
      } catch {
        // 预热失败不影响可用性
      }
    }, 0);
    loop.start();
    // 关 store 必须排在 flush **之后**, 所以合并成同一个 disposer。
    return async () => {
      loop.stop();
      try {
        await flushAll();
      } finally {
        if (ownsStore && !closed) {
          closed = true;
          store.close();
        }
      }
    };
  }, "hx-memory.lifecycle()");
}
