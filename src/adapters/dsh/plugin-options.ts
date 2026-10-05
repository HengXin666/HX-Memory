// src/adapters/dsh/plugin-options.ts — 插件入口的选项形状与默认路径。
//
// 为什么从组装根抽出来 (§407 行上限): 这块内容与"记忆怎么工作"无关, 它只回答两个问题 ——
// "宿主可以传哪些参数进来"、"不给参数时记忆根落在哪"。它的变化原因也跟着宿主/部署环境走,
// 而不是跟着业务走。组装根只再导出一次, 保持 `apply` 的调用方无需改导入路径。

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { FileBackend } from "../../storage/file-store.js";
import type { BindingConfig } from "../../kernel/binder.ts";
import type { HxMemorySettings } from "./types.js";

export interface HxMemoryPluginOptions {
  /** 记忆根目录 (默认 $DSH_HOME/hx-memory, 再退回 ~/.dsh/hx-memory)。 */
  root?: string;
  /** 存储层 (可选: 不传则用 root 自建默认 FileBackend)。 */
  store?: FileBackend;
  /** Review 队列目录 (可选: 默认 <root>/review)。 */
  reviewDir?: string;
  settings?: Partial<HxMemorySettings>;
  /** 声明式记忆绑定 (VCP 式记忆拓扑): 项目 → 绑定哪些记忆源。 */
  bindings?: BindingConfig[];
}

/**
 * 默认记忆根: $HX_MEMORY_ROOT → $DSH_HOME/hx-memory → ~/.dsh/hx-memory。
 * 跟随 DSH_HOME 很重要: 多实例/CI 用 DSH_HOME 隔离状态, 记忆根不能落在共享的 ~/.dsh。
 */
export function defaultMemoryRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (env.HX_MEMORY_ROOT?.trim()) return env.HX_MEMORY_ROOT.trim();
  const dshHome = env.DSH_HOME?.trim();
  if (dshHome) return resolve(dshHome, "hx-memory");
  return join(homedir(), ".dsh", "hx-memory");
}
