// src/frustration/workspace.ts — 工作位置 (仓库根、当前目录) 与最近一次 diff。
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

/** 从 cwd 找 git 仓库根; 不是仓库时 repo 退回 cwd 本身。 */
export function locateWorkspace(cwd: string): { repo: string; cwd: string } {
  const abs = resolve(cwd || process.cwd());
  try {
    const top = execFileSync("git", ["-C", abs, "rev-parse", "--show-toplevel"], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    return { repo: top || abs, cwd: abs };
  } catch {
    return { repo: abs, cwd: abs };
  }
}

/** 最近一次 diff: 工作区未提交改动; 没有时取最近一次提交。最多 8000 字。 */
export function recentDiff(repo: string): string {
  const run = (args: string[]): string => {
    try {
      return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", timeout: 3000, maxBuffer: 4 << 20, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return "";
    }
  };
  const working = run(["diff", "--no-color", "-U2", "HEAD"]);
  const out = working.trim() ? working : run(["show", "--no-color", "-U2", "--stat", "--patch", "HEAD"]);
  return out.length > 8000 ? out.slice(0, 8000) + "\n…(截断)" : out;
}
