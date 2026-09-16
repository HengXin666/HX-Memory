# Agent Note: 插件卸载释放 store 句柄 (热重载前提)

Status: implemented

## Problem

DSH 的 cordis HMR (\`@deepseek-ai/cordis-plugin-hmr\`) 语义是 **dispose 旧 fiber → 再 apply() 一次**。
而 \`adapters/dsh/index.ts\` 的 \`apply()\` 会 \`new FileBackend({ root })\`, 它内部
\`new DatabaseSync(join(root, "index.sqlite"))\` 持有文件描述符。

修复前 \`src/adapters/dsh/\` 里**没有任何 \`store.close()\`** (只有 codex CLI 那边关)。于是每次热重载:

- 漏一个 SQLite fd (实测 4 轮重载留下 **9 个 fd**, 见下方 Testing),
- 叠加 WAL/SHM 争用, 最终 \`database is locked\`。

这条是给热重载**开闸前必须先补**的前提: 不补就是给宿主埋一个随重载次数增长的定时炸弹。

## Decision

在既有的 \`hx-memory.lifecycle()\` disposer 里补上 close, 并遵守三条约束:

1. **谁创建谁关闭**: 只有 \`!opts.store\` 时才 close。注入进来的 store 属于调用方,
   插件关它属于越权 (调用方可能还要用, 或会重复 close 抛错)。
2. **close 排在 flush 之后**: \`runtime.flushAll()\` 还要写库。合并进**同一个** disposer 的
   \`try/finally\` —— 另起一个 effect 的话两者卸载顺序是隐式的, 一旦反过来就是"关库后再写"。
3. **幂等**: 用 \`storeClosed\` 标志挡住重复 close (node:sqlite 的 \`DatabaseSync.close()\`
   对已关连接会抛), HMR 反复 dispose 时不能炸。

## Consequences

- 热重载不再泄漏 SQLite 句柄, 反复装载/卸载后 fd 回落到基线 (回归用例钉住)。
- 插件卸载更干净: 之前 \`maintenance.loop.stop()\` + \`flushAll()\` 已做对, 只差 store。
- 注入 store 的调用方 (测试、codex 适配器) 行为不变 —— 仍由它们自己 close。
- 一次性 CLI 场景无害: posix 进程退出本就会释放 fd。

## Alternatives considered

**另起一个 \`ctx.effect(() => () => store.close())\`。** 不选: 与 flush 的卸载顺序变成隐式的,
一旦 close 先跑就是"关库后再写缓冲", 而且是静默丢数据。

**无条件 \`store.close()\` (不看是否注入)。** 不选: 会关掉调用方的 store,
测试里紧接着 \`injected.query({})\` 就会抛, 也违反"谁创建谁关闭"。

**不补 disposer, 改用 \`process.on('exit')\` 兜底。** 不解决问题: HMR 不退出进程,
exit 钩子根本不会触发, fd 照样累积。

**用 \`store.close()\` 前先判 \`store.db.open\` 之类的内部状态。** 不选: 那是存储层内部细节,
适配器不该依赖; 用本地布尔标志即可, 且不增加端口面积。

## 落地形态

实现落在**新文件** \`src/adapters/dsh/lifecycle-wiring.ts\` (\`wireLifecycle\`), 由 \`index.ts\` 调用。
原因有两个, 第二个是硬约束:

1. 生命周期 (预热 + 卸载清理) 是天然独立的职责, 与组装根的"接线"性质不同;
2. 组装根撞上 **400 行上限** (\`verify-structure\` 报 "index.ts 有 401 行")。整段搬走后
   \`index.ts\` 回到 376 行 —— 这条闸门确实拦住了本次改动, 记在这里避免下次再撞。

形态与既有的 \`settings-wiring.ts\` / \`maintenance-wiring.ts\` 一致 (deps 对象进, 不返回句柄)。

## Testing

\`tests/s2/store-disposer.test.ts\` (5 用例):

- 卸载后该 root 的 fd 归 0;
- **反复装载/卸载 4 轮不累积 fd** (漏一个就留下 N 个);
- disposer 幂等 (重复卸载不抛);
- 注入的 store 不被关闭 (仍持有 fd, 且 \`query\` 可用);
- lifecycle disposer 返回 Promise (保证 close 在 await flushAll 之后)。

**判据为什么用 fd 计数**: 第一版用"卸载后重开同一 root 能跑 rebuild 且不锁"做断言,
结果**去掉 close 后 4 条全绿** —— 实测 SQLite 允许未关闭的连接旁边再开一个连接并写入,
reopen 类断言区分不出有无 close, 是假闸门。改用 \`/proc/self/fd\` 计数后才真正有牙:
把 close 改成 \`if (false && ...)\` 后该用例报 \`expected 9 to be +0\`。

## 真实宿主验证 (端到端)

单元测试之外, 在**隔离的 \`DSH_HOME\`** 里真起了宿主 \`dsh web --port 0\` (不碰用户运行中的实例):

- 打开 hmr 后启动**无报错** —— 说明 \`cordis-plugin-loader\` 走的是
  \`node-addon-require-builtin\` 兜底, **不需要 \`--expose-internals\`**
  (HMR 构造函数里有 \`if (!this.ctx.loader.internal) throw\` 这道闸, 值得记下);
- 改 \`dist/\` 下的文件后, 宿主日志真的打印出被改模块的 re-execute 标记 → **热重载生效**;
- 连续 **8 次**重载, 该进程的 sqlite 相关 fd 稳定在 **4**、总 fd 稳定在 **28**, 不再增长
  (漏的话每轮 +2 并在 4 轮后到 9+)。
