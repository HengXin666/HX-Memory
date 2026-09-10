// src/bindings/store.ts — BindingConfig 的持久化存储。
// 真相在文件 (bindings.json, git 可审), 与 HX-Memory 的 truth-in-files 哲学一致。
// 面板 (DSH Web) 与 CLI 都经它读写; 改动即生效 (Binder 读实时配置)。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BindingConfig } from "../kernel/binder.ts";

export const BINDINGS_FILE = "bindings.json";

export class BindingStore {
  private readonly path: string;
  private configs: BindingConfig[];

  // 显式字段赋值, 不用参数属性 (strip-only TS 模式不支持)。
  constructor(root: string) {
    this.path = join(root, BINDINGS_FILE);
    this.configs = this.load();
  }

  private load(): BindingConfig[] {
    if (!existsSync(this.path)) return [];
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as unknown;
      if (!Array.isArray(raw)) return [];
      return raw.filter(isBindingConfig);
    } catch {
      return [];
    }
  }

  /** 全量替换 (面板保存即整体写回 — 小文件, 无需增量合并)。 */
  saveAll(configs: BindingConfig[]): void {
    this.configs = configs.filter(isBindingConfig);
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.configs, null, 2) + "\n", "utf8");
  }

  list(): BindingConfig[] {
    return this.configs;
  }

  /** 某项目的绑定 (无则空数组)。 */
  forProject(project: string): BindingConfig["bindings"] {
    return this.configs.find((c) => c.project === project)?.bindings ?? [];
  }

  /** upsert 一个项目的绑定集合。 */
  upsert(project: string, bindings: BindingConfig["bindings"]): void {
    const next = this.configs.filter((c) => c.project !== project);
    next.push({ project, bindings });
    this.saveAll(next);
  }

  remove(project: string): void {
    this.saveAll(this.configs.filter((c) => c.project !== project));
  }
}

function isBindingConfig(v: unknown): v is BindingConfig {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.project === "string" && Array.isArray(o.bindings);
}
