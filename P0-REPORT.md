# P0 报告: 并发写完整性 + 外置宿主默认关闭

**结论: P0 全部判据达标, 无遗留。J1.2 / M5 = 1.00; J1.1 外置宿主默认不挂载。第 4 节的命令都已在真仓库上跑过并通过。**

日期: 2026-11-01。环境: Node v22.23.3, vitest 3.2.7。第 1 节和第 2 节在源码副本上测得; 第 4 节以用户在真仓库上的复跑结果为准 (2026-11-01)。

## 1. 改造前基线 (原始证据, 单列)

命令 (改动前的 `src/external/store.ts` 与 `src/storage/markdown-codec.ts`, 其余文件相同):

```
node --experimental-strip-types --no-warnings scripts/eval/concurrency.ts --procs 2 --each 200 --runs 3
```

| 目标 | run 1 | run 2 | run 3 | 预期 |
|---|---|---|---|---|
| canonical (外置 CanonicalStore, D1) | 238 | 235 | 301 | 400 |
| file (原生 FileBackend 真相 markdown, D17) | 352 | 329 | 380 | 400 |

- **M5 = 0.59** (min 235/400), **退出码 1**。
- canonical 目标的子进程报错原文: `Error: ENOENT: no such file or directory, rename '.../banks/ws_eval/bundle.json.tmp' -> '.../bundle.json'`。根因是两个进程共用固定临时名 `.tmp`, 写入时没有锁 (原 `src/external/store.ts:123-128`)。
- file 目标: **writeErrors = [0,0]**, 丢了 20-71 条却一个错都不报。D17 由此证实: 跨进程读-改-写会静默丢更新。原 `src/storage/markdown-codec.ts` 的注释里也写了这一点。

## 2. 改造后对照 (runs 20)

命令: `node --experimental-strip-types --no-warnings scripts/eval/concurrency.ts --procs 2 --each 200 --runs 20`, **退出码 0**, 输出 `M5 = 1.00 (threshold 1.00, runs 40)`。

| 目标 | 运行次数 | stored 最小/最大 | 写错误合计 | 解析错误 | 单次耗时 最小/中位/最大 (ms) |
|---|---|---|---|---|---|
| canonical | 20 | 400 / 400 | 0 | 0 | 1014 / 1788 / 3865 |
| file | 20 | 400 / 400 | 0 | 0 | 869 / 1119 / 5314 |

改造前后对比: M5 从 0.59 (退出码 1) 变为 1.00 (退出码 0)。基线只跑了 3 次, 对照跑了 20 次; 基线的单次耗时没有记录 (未测), 所以加锁带来的耗时变化目前不能下结论。

## 3. 改动清单 (都已 PUT 并逐字节回读一致)

| 文件 | 行数 | 改动 |
|---|---|---|
| src/storage/file-lock.ts (新建) | 146 | 同步跨进程锁: `openSync(path,"wx")` (O_EXCL) 建锁文件, 写入 pid+时间; 持锁 pid 已死或持锁超过 30 s 时可接管, 接管时用 mkdir 互斥; 等待超时 (默认 10 s) 抛错; 释放时只删自己持有的锁 |
| src/external/store.ts | 150 | saveMemory / importBank / saveDoc / importCorpus 的整段读-改-写都持 `<bundle>.lock`; 临时名改为 `.tmp-<pid>-<随机12hex>`; 写完先 fsync 再 rename; rename 失败时清掉临时文件 |
| src/storage/markdown-codec.ts | 263 | upsertBlockInFile / removeBlockFromFile / appendBlockToFile 都持 `<file>.lock`; 临时名加随机后缀 |
| src/adapters/dsh/external-bridge.ts | 217 | 新增 `externalHostEnabled(env)`: 只有 `HX_EXTERNAL_HOST === "1"` 才返回 true |
| src/adapters/dsh/prestep-wiring.ts | 130 | 默认不调用 attachExternalHost; 关闭时不传 externalPreface, session/event 也不触发外置 retain |
| scripts/eval/concurrency.ts (新建) | 207 | M5 评测: 起真实子进程, 跑 canonical 和 file 两个目标, 结果写入 `eval-out/M5.json`; 退出码 0 达标 / 1 未达标 / 2 参数无效 / 3 子进程崩溃 |
| tests/eval/concurrency.test.ts (新建) | 147 | 4 条用例: 两进程共 400 条; canonical 写到一半被 SIGKILL; FileBackend 写到一半被 SIGKILL; 锁的获取、释放、超时与接管 |

锁文件以 `.lock` 结尾: `walkMd` 和 truth-files 只读 `.md`, CanonicalStore 只读 `bundle.json`, sweepAtomicTemps 只清理带 `.tmp-` 的文件, 所以锁文件不会被当成真相读入, 也不会被误删。

## 4. 验收命令与退出码 (真仓库, 用户复跑)

| # | 命令 | 结果 | 退出码 |
|---|---|---|---|
| 1 | `node --experimental-strip-types --no-warnings scripts/eval/concurrency.ts --procs 2 --each 200 --runs 20` | M5 = 1.00, 40/40 次 stored=400 | 0 |
| 2 | `npx vitest run tests/eval` | 4/4 通过 | 0 |
| 3 | `npx vitest run tests/s2` | 127 个文件、860 条用例全部通过, 3.33 s | 0 |
| 4 | `./node_modules/.bin/tsc --noEmit -p .` | 无报错 | 0 |

docs-gate (`tests/s1/docs-gate.test.ts`) 在真仓库上报 2 处问题: `AGENTS.md:4` 和 `docs/memory-four-timings-comparison.md:19`。在 HEAD 上 stash 掉本次改动后同样失败, 确认是既有问题, 与 P0 无关, 不算 P0 的遗留项。

## 5. 不属于 P0 判据的事项 (归入后续阶段, 不算遗留)

- FileBackend 里的 SQLite 索引仍是每个进程各自写入; 本次只保证真相 markdown 不丢块。
- `store.update` 这类先读 existing 再写的路径, 锁只包住了写文件这一步, 条目级的旧值覆盖仍有可能 (属于 D6 / P1)。
- 锁基于本地文件系统的 O_EXCL, 没在 NFS 上测过。
