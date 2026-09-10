// src/adapters/codex/cli.ts — HX-Memory 独立 CLI (适合 Codex/pre-commit/手动/迁移运维)。
// 用法:
//   node dist/adapters/codex/cli.js rules   --root <memRoot>
//   node dist/adapters/codex/cli.js sync    --root <memRoot> --repo <repoRoot>
//   node dist/adapters/codex/cli.js stats   --root <memRoot>
//   node dist/adapters/codex/cli.js verify  --root <memRoot>
//   node dist/adapters/codex/cli.js rebuild --root <memRoot> [--episodes] [--since <iso>]
//   node dist/adapters/codex/cli.js consolidate --root <memRoot> [--dry-run]  # 衰减扫描 (可逆)
//   node dist/adapters/codex/cli.js mcp     --root <memRoot>   # MCP stdio 服务 (给任意 MCP 客户端)
// 纯 Node, 零 harness 依赖 (Facade + 内核服务直连, 与 DSH 面板走同一套语义)。
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FileBackend } from "../../storage/file-store.ts";
import { EpisodeStore } from "../../storage/episode-store.ts";
import { HybridRetriever } from "../../retrieval/hybrid.ts";
import { MemoryFacade } from "../../app/facade.ts";
import { RebuildService } from "../../app/rebuild.ts";
import { CodexAdapter } from "./adapter.ts";
import { openMemoryStack } from "../../app/stack.ts";
import { serveMcpStdio } from "../../surfaces/mcp/server.ts";

/**
 * 解析 --key value 与布尔开关 --flag。
 * 注意: 末尾的 --flag 没有后继值时必须是 "true" 而不是 "" ——
 * 后者在 `if (flags["flag"])` 里是假值, 会把"打开开关"静默解释成"没打开" (真实踩过)。
 */
function parseArgv(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[a.slice(2)] = "true";
    } else {
      out[a.slice(2)] = next;
      i++;
    }
  }
  return out;
}

export async function main(argv: string[]): Promise<number> {
  const [cmd] = argv;
  const flags = parseArgv(argv.slice(1));
  const root = flags["root"];
  if (!root) {
    console.error(
      "usage: hx-memory <sync|rules|stats|verify|rebuild|consolidate|mcp> --root <memRoot> [--repo <repoRoot>] [--episodes] [--since <iso>] [--dry-run]",
    );
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

  if (cmd === "stats") {
    const facade = new MemoryFacade({ store, retriever: new HybridRetriever(store) });
    facade.withIndexStatus(() => store.ftsStatus());
    console.log(JSON.stringify(await facade.stats(), null, 2));
    store.close();
    return 0;
  }

  if (cmd === "verify") {
    const episodes = new EpisodeStore({ root });
    const report = await new RebuildService({ store, episodes }).verify();
    console.log(JSON.stringify(report, null, 2));
    store.close();
    return report.ok ? 0 : 1;
  }

  if (cmd === "rebuild") {
    const episodes = new EpisodeStore({ root });
    const service = new RebuildService({ store, episodes });
    // 默认 T1 (索引 ← 真相); --episodes 走 T2 (原文重放, 换抽取器时用)。
    const report = flags["episodes"]
      ? await service.rebuildFromEpisodes(flags["since"] ? { since: flags["since"] } : {})
      : await service.rebuildIndex();
    console.log(JSON.stringify(report, null, 2));
    console.log(
      flags["episodes"]
        ? "T2 抽取重建: 新增 " +
            report.created +
            ", 未变 " +
            report.unchanged +
            ", 取代 " +
            report.superseded
        : "T1 索引重建: " + report.created + " 条",
    );
    store.close();
    return report.errors.length ? 1 : 0;
  }

  if (cmd === "consolidate") {
    // 衰减扫描 (S3 的确定性部分): 只对短命种类 + 从未被命中的条目判过期, 永不删除。
    const stack = openMemoryStack(root);
    const report = await stack.consolidate.run({ dryRun: flags["dry-run"] === "true" });
    console.log(JSON.stringify(report, null, 2));
    console.log(
      "整合: 扫描 " +
        report.scanned +
        ", 过期 " +
        report.expiring.length +
        (report.applied ? " (已写入)" : " (干跑, 未写入)"),
    );
    stack.close();
    return 0;
  }

  if (cmd === "mcp") {
    // MCP stdio 服务: 任何 MCP 客户端 (Claude Code/Desktop、Cursor、Cline…) 都能接。
    // 注意 stdout 被协议独占 —— 任何调试输出都必须走 stderr。
    store.close();
    const stack = openMemoryStack(root, { episodeRetentionDays: 0 });
    try {
      await serveMcpStdio({
        facade: stack.facade,
        onError: (error) => console.error("[hx-memory mcp] " + String(error)),
      });
    } finally {
      stack.close();
    }
    return 0;
  }

  console.error("未知命令: " + cmd);
  store.close();
  return 1;
}

// 自执行入口: 只有被当作脚本直接运行时才跑 (被 import 时保持纯函数, 便于测试)。
// 之前这里没有入口 —— bin 指向 cli.js 但没人调 main(), 于是 `hx-memory rules` 静默什么都不做。
const invoked = process.argv[1] ? resolve(process.argv[1]) : "";
if (invoked && invoked === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(String(error));
      process.exitCode = 1;
    });
}
