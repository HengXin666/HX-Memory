// src/adapters/codex/cli.ts — HX-Memory 独立 CLI (适合 Codex/pre-commit/手动)。
// 用法: node dist/adapters/codex/cli.js sync --root <memRoot> --repo <repoRoot>
//       node dist/adapters/codex/cli.js rules --root <memRoot>
// 纯 Node, 零 harness 依赖。
import { FileBackend } from "../../storage/file-store.ts";
import { CodexAdapter } from "./adapter.ts";

function parseArgv(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) out[a.slice(2)] = argv[i + 1] ?? "";
  }
  return out;
}

export async function main(argv: string[]): Promise<number> {
  const [cmd] = argv;
  const flags = parseArgv(argv.slice(1));
  const root = flags["root"];
  if (!root) {
    console.error("usage: hx-memory <sync|rules> --root <memRoot> [--repo <repoRoot>]");
    return 1;
  }
  const store = new FileBackend({ root });

  if (cmd === "rules") {
    const rules = store.query({ kind: "rule", scope: "global" });
    console.log("确认规则 " + rules.length + " 条:");
    for (const r of rules) console.log("- [" + r.id + "] " + r.content);
    store.close();
    return 0;
  }

  if (cmd === "sync") {
    const repo = flags["repo"];
    if (!repo) {
      console.error("sync 需要 --repo <repoRoot>");
      store.close();
      return 1;
    }
    const adapter = new CodexAdapter({ store, repoRoot: repo });
    const res = (await adapter.onSessionStart({ id: "cli" })) as {
      updated: boolean;
      rules: number;
    };
    console.log(res.updated ? "AGENTS.md 已更新 (" + res.rules + " 条规则)" : "AGENTS.md 无变化");
    store.close();
    return 0;
  }

  console.error("未知命令: " + cmd);
  store.close();
  return 1;
}
