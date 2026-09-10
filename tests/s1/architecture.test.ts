// tests/s1/architecture.test.ts — 分层铁律: 依赖方向单向, 越层即失败。
//
// 为什么需要: docs/architecture-v2.md 声明 "L3 → L2 → L1 ← L0 单向, 任何一层 import 上一层 = bug"。
// 这条声明如果没有测试, 就会在第一次"图省事直接 import 引擎"时静默失效 —— 而那正是 v1 的老问题
// (DSH 的工具直接调 FileBackend)。这里用源码文本扫描把它变成可失败的断言。
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const SRC = resolve(import.meta.dirname, "../../src");

/** 收集 src 下所有 ts/tsx (排除 client, 它有宿主 DOM 依赖)。 */
function sourceFiles(dir = SRC): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "client" || entry.name === "node_modules") continue;
      out.push(...sourceFiles(full));
    } else if (/\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** 取出一个源文件里的 import/export-from 模块路径。 */
function importsOf(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const out: string[] = [];
  for (const m of text.matchAll(/from\s+"([^"]+)"/g)) out.push(m[1] ?? "");
  for (const m of text.matchAll(/import\s*\(\s*"([^"]+)"\s*\)/g)) out.push(m[1] ?? "");
  return out.filter(Boolean);
}

const files = sourceFiles();
const rel = (f: string) => relative(SRC, f).split(/[\\/]/).join("/");

/** 哪些顶层目录属于哪一层 (用于越层判定)。 */
const LAYER: Record<string, string> = {
  kernel: "L1",
  trigger: "L2",
  capture: "L2",
  recall: "L2",
  generalize: "L2",
  evolution: "L2",
  retrieval: "L0",
  storage: "L0",
  app: "L2",
  adapters: "L3",
};

function layerOf(relPath: string): string | null {
  const top = relPath.split("/")[0] ?? "";
  return LAYER[top] ?? null;
}

describe("分层铁律 (依赖方向单向)", () => {
  it("kernel 不 import harness / 存储 (内核零依赖)", () => {
    const offenders: string[] = [];
    for (const file of files.filter((f) => rel(f).startsWith("kernel/"))) {
      for (const spec of importsOf(file)) {
        const resolved = spec.startsWith(".") ? resolve(join(file, ".."), spec) : spec;
        const target = relative(SRC, resolved).split(/[\\/]/).join("/");
        if (target.startsWith("storage/") || target.startsWith("adapters/")) {
          offenders.push(`${rel(file)} → ${spec}`);
        }
      }
    }
    expect(offenders, "kernel 不得依赖存储/宿主实现").toEqual([]);
  });

  it("应用层 (L2) 不 import 宿主适配层 (L3)", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const layer = layerOf(rel(file));
      if (layer !== "L2") continue;
      for (const spec of importsOf(file)) {
        if (!spec.startsWith(".")) continue;
        const target = relative(SRC, resolve(join(file, ".."), spec))
          .split(/[\\/]/)
          .join("/");
        if (target.startsWith("adapters/")) offenders.push(`${rel(file)} → ${spec}`);
      }
    }
    expect(offenders, "应用层不得依赖具体宿主").toEqual([]);
  });

  it("引擎层 (storage/retrieval) 不 import 应用层或宿主", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const top = rel(file).split("/")[0] ?? "";
      if (top !== "storage" && top !== "retrieval") continue;
      for (const spec of importsOf(file)) {
        if (!spec.startsWith(".")) continue;
        const target = relative(SRC, resolve(join(file, ".."), spec))
          .split(/[\\/]/)
          .join("/");
        const upper = target.split("/")[0] ?? "";
        if (
          ["adapters", "app", "capture", "recall", "generalize", "evolution", "trigger"].includes(
            upper,
          )
        ) {
          offenders.push(`${rel(file)} → ${spec}`);
        }
      }
    }
    expect(offenders, "引擎层只依赖 kernel 端口").toEqual([]);
  });

  it("端口层只有类型与纯函数 (kernel 不 import node:fs / node:sqlite 等宿主能力)", () => {
    const offenders: string[] = [];
    for (const file of files.filter((f) => rel(f).startsWith("kernel/"))) {
      for (const spec of importsOf(file)) {
        if (/^node:(fs|sqlite|http|child_process|net|worker_threads)/.test(spec)) {
          offenders.push(`${rel(file)} → ${spec}`);
        }
      }
    }
    expect(offenders, "kernel 必须能在纯逻辑环境 (S1) 运行").toEqual([]);
  });

  it("适配层可以依赖内核与引擎 (正向依赖不受限)", () => {
    const dsh = files.find((f) => rel(f) === "adapters/dsh/index.ts");
    expect(dsh, "adapters/dsh/index.ts 应存在").toBeDefined();
    const specs = importsOf(dsh!);
    expect(specs.some((s) => s.includes("storage/file-store"))).toBe(true);
  });
});
