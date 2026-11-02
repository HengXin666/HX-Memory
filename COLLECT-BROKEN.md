# 采集停摆 21 天: 根因

> 结论先行: **不是 hook 没挂、不是异常被吞, 而是插件根本没被加载。**
> `@hengxin666/hx-memory` 仍是 web profile 的依赖, 但已经**不在 `dsh.profile.bundles` 选择列表里**。
> 2026-10-11 06:44 ~ 07:03 UTC 之间 DSH 重启, 重启后的进程不再导入本插件 ⇒ 没有 `session/event` 订阅、
> 没有 `agent/pre-step` 注入、没有 memory_* 工具, 也就没有任何报错 (从没 import, 就不会 throw)。

## 1. 证据链 (全部是宿主上的原始文件, 可复查)

| # | 查什么 | 命令 / 文件 | 结果 |
|---|---|---|---|
| 1 | 采集账本最后一天 | `ls ~/.dsh/hx-memory/capture/` | 最后一个文件 `2026-10-11.jsonl`; 今天 (11-01) **没有**文件 ⇒ 当前会话也没在采集 |
| 2 | 最后一条落盘 | `tail -1 ~/.dsh/hx-memory/capture/2026-10-11.jsonl` | session-1911b5f4 turn 32/33, 2026-10-11 06:4x UTC |
| 3 | 那个会话最后一个事件 | `session-1911b5f4…/session.v4.jsonl.zstd` | 最后事件 2026-10-11 **06:44:54** UTC, 与 capture/episodes/digest 的最后 mtime 一致 |
| 4 | 停摆前的会话里插件在不在 | 同上, 统计 `user/message.source.kind` | `plugin:hx-memory` **33 条** (注入块 + 沉淀回执); 系统提示词里有 `memory_search / memory_save / memory_flag / memory_evidence / memory_rule_propose` |
| 5 | 停摆后第一个会话 | `session-c68a4d49…` (createdAt 2026-10-11 **07:03:39** UTC, 同一工作区 HX-Jungle, 同一 agentPreset ptc) | `plugin:hx-memory` **0 条**; 系统提示词里 memory_* 工具 **0 个** ⇒ 插件未加载 |
| 6 | profile 的选择列表 | `~/.dsh/profiles/web/package.json` → `dsh.profile.bundles` | 11 项, **没有** `@hengxin666/hx-memory`; 但 `dependencies` 里仍有 `"@hengxin666/hx-memory": "link:/home/hx/Loli/code/HXLoLis/components/HX-Memory"` |
| 7 | 以前在不在 | `package.json.bak-1790412977` (2026-09-26) 与 `package.json.bak-purge-20261001-185346` | 两份备份的 bundles **都有** `@hengxin666/hx-memory` (同时还有 `dsh-purge`/`dsh-jejudge`/`dsh-taskspan`, 现在也都不在了) |
| 8 | 这种"依赖在、选择没了"的形态是谁产生的 | `dsh-plugin-manager/README.zh.md` 第 40 行 | "组合包开关修改 `package.json` 的有序 `dsh.profile.bundles` 列表。**关闭保留依赖**; 开启追加到列表末尾" ⇒ 与现状逐字吻合: 是插件页/`plugin_manager` 的**关闭**操作 |
| 9 | 不是版本拒绝 | `dsh-app-boot/README.zh.md` 第 52-54 行 + `compatibility.json` | 版本不兼容只会"跳过组合包并列入 skippedBundles", **不改 package.json**; 且"预发布版本参与范围匹配", `^0.2.0-rc.1` 覆盖 0.2.1-rc.1 |
| 10 | 不是 hook | `~/.dsh/hooks/` | 只有 `dsh_review_hook.py` / `dsh_timeout_hook.py`, 与本插件无关: 本插件从来不靠 `~/.dsh/hooks`, 它是 cordis 插件, 靠 `ctx.on("session/event")` (src/adapters/dsh/prestep-wiring.ts:132) 与 `ctx.on("agent/pre-step")` (prestep-wiring.ts:72) 接线 |
| 11 | 为什么看起来"接线还在" | `~/.dsh/profiles/web/cordis.patch.yml` | HMR 段仍把 watch 根指向 `HX-Memory/dist` ⇒ 改代码、重构建都"正常", 但组合树里没有本插件这一行, HMR 无物可重载 |

## 2. 三个候选成因的判定

- **hook 没挂**: 否。注册点 (prestep-wiring.ts:72/132, session-wiring.ts:73/86) 只有在插件被 import 时才执行; 证据 5 说明 import 本身没发生。
- **进程没跑**: 否。DSH 本身在跑 (10-11 之后有 543 个新会话, 其中 286 个根会话), 只是这个进程里没有本插件。
- **报错被吞**: 否。插件内部的 `onError`/`quietly` 只包住捕获与注入; 没加载就没有任何可吞的错误。`~/.dsh/logs/startup-*.log` 里也没有 hx-memory 的失败记录 (10-17 的那次启动失败是 3080 端口占用, 与本插件无关)。

**根因: 组合包选择列表里丢了本插件 (插件管理器的"关闭"语义: 保留依赖、取消选择), 下一次重启后静默失效。**
谁、在哪次操作里关掉的无法从文件确定 (插件管理器只给 pnpm 操作写日志, 开关不写); 能确定的是时间窗: 关闭发生在 10-01 之后, 生效于 10-11 06:44~07:03 UTC 的那次重启。

## 3. 为什么 21 天没人发现

插件只能观测"自己活着时"的事。它不在进程里时, 唯一的外部信号是 capture 目录不再长新文件  而之前没有任何地方盯着这个。
面板 overview 的 ageHours 黄标是第一个看得到它的地方 (510.9 h)。

## 4. 修复

1. **恢复选择** (`scripts/capture-repair.sh`): 备份 `package.json` → 把 `@hengxin666/hx-memory` 追加回 `dsh.profile.bundles` (与插件页"开启"同一语义: 追加到末尾) → `pnpm run build && pnpm run build:client` (dist 与 src 对齐) → 提示重启 DSH。
   幂等: 已在列表里就不改。
2. **可观测**: 面板 `GET /api/hooks` 新增 `plugin` 段, 直接读 profile 的 `dependencies` 与 `dsh.profile.bundles`, 给出 `selected / installed / lastCapture / verdict`;
   "依赖在、未选入" 与 "选入了但 24h 无采集" 都会标红, 不再只是一个年龄数字。
3. **验收**: 重启后开一轮对话, `ls ~/.dsh/hx-memory/capture/$(date -u +%F).jsonl` 出现、面板 hooks 的 `plugin.verdict = "ok"`。
4. **补数**: 停摆期间的会话用 `scripts/backfill-sessions.ts` 重放 (见 MEMORY-DECAY.md §5)。
