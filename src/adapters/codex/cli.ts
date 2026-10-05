// src/adapters/codex/cli.ts — HX-Memory 独立 CLI (适合 Codex/pre-commit/手动/迁移运维)。
// 用法:
//   node dist/adapters/codex/cli.js rules   --root <memRoot>
//   node dist/adapters/codex/cli.js sync    --root <memRoot> --repo <repoRoot>
//   node dist/adapters/codex/cli.js stats   --root <memRoot>
//   node dist/adapters/codex/cli.js verify  --root <memRoot>
//   node dist/adapters/codex/cli.js rebuild --root <memRoot> [--episodes] [--since <iso>]
//   node dist/adapters/codex/cli.js consolidate --root <memRoot> [--dry-run]  # 衰减扫描 (可逆)
//   node dist/adapters/codex/cli.js normalize  --root <memRoot> [--dry-run]  # 主动整理 (形态规范化, 无损)
//   node dist/adapters/codex/cli.js digest  --root <memRoot> [--project <p>]  # 当前知识摘要 (派生视图, 不落盘)
//   node dist/adapters/codex/cli.js export  --root <memRoot> [--format jsonl|markdown] > backup.jsonl
//   node dist/adapters/codex/cli.js import  --root <memRoot> [--format jsonl|markdown] < backup.jsonl
//   node dist/adapters/codex/cli.js mcp     --root <memRoot>                        # MCP stdio 服务
//   node dist/adapters/codex/cli.js mcp --http --port 4399 [--token <t>] [--host <h>] # MCP over HTTP
// 纯 Node, 零 harness 依赖 (Facade + 内核服务直连, 与 DSH 面板走同一套语义)。
import { resolve } from "node:path";
import { relinkAll } from "../../app/relink.ts";
import { fileURLToPath } from "node:url";
import { FileBackend } from "../../storage/file-store.ts";
import { EpisodeStore } from "../../storage/episode-store.ts";
import { HybridRetriever } from "../../retrieval/hybrid.ts";
import { MemoryFacade } from "../../app/facade.ts";
import { RebuildService } from "../../app/rebuild.ts";
import { CodexAdapter } from "./adapter.ts";
import { openMemoryStack } from "../../app/stack.ts";
import { serveMcpStdio } from "../../surfaces/mcp/server.ts";
import { createMcpHttpServer } from "../../surfaces/mcp/http.ts";
import { exportMemory, importMemory } from "../../app/transfer.ts";

/**
 * 解析 --key value 与布尔开关 --flag。
 * 注意: 末尾的 --flag 没有后继值时必须是 "true" 而不是 "" ——
 * 后者在 `if (flags["flag"])` 里是假值, 会把"打开开关"静默解释成"没打开" (真实踩过)。
 */
/** 报告里"是否真的写入了"的可读判定 (dryRun 与 applied 组合, 避免两处措辞漂移)。 */
function flagApplied(report: { dryRun: boolean; applied: boolean }): boolean {
  return !report.dryRun && report.applied;
}

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
      "usage: hx-memory <sync|rules|stats|digest|search|evidence|relink|export|import|verify|rebuild|consolidate|normalize|maintain|mcp> --root <memRoot> [--repo <repoRoot>] [--episodes] [--since <iso>] [--dry-run] [--http --port N --token T]",
    );
    console.error("  search  --text <query> [--limit N]");
    console.error("  evidence --id <memoryId>   (trace a memory back to its raw turns; exit 2 = 溯源不完整)",
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

  if (cmd === "export" || cmd === "import") {
    // 迁移与备份: export 走 stdout (可重定向), import 走 stdin (可管道)。
    // 只认领域类型, 因此 A 引擎导出、B 引擎导入永远可行 (兑现"存储层可插拔")。
    const stack = openMemoryStack(root);
    const format = (flags["format"] === "markdown" ? "markdown" : "jsonl") as "jsonl" | "markdown";
    if (cmd === "export") {
      for await (const chunk of exportMemory(await stack.store.all(), format))
        process.stdout.write(chunk);
      stack.close();
      return 0;
    }
    async function* stdinLines(): AsyncIterable<string> {
      for await (const chunk of process.stdin) yield String(chunk);
    }
    const report = await importMemory(stack.store, stdinLines(), { format });
    console.log(JSON.stringify(report, null, 2));
    stack.close();
    return report.errors.length ? 1 : 0;
  }

  if (cmd === "maintain") {
    // P3 后台维护的**子进程入口** (由 DSH 调度器在空闲窗内启动)。
    //
    // 为什么这个命令必须自己做事、而不是再委托给别人: 它**就是**那个隔离进程。
    // 维护是批量改写真相文件的工作, 因此签名里没有任何交互式输出; 结果以 JSON 打到 stdout,
    // 由父进程记进环形缓冲 (失败时 stdout 的那一行就是证据)。
    // 保留期由调用方 (DSH 调度器) 显式传入: 本命令是**子进程**, 拿不到用户在面板里配的值,
    // 而 EpisodeStore 的缺省是 "0 = 永久" —— 不传就等于清理永远不生效 (静默 no-op, 踩过)。
    // 缺省仍按 0 处理: 手动跑 maintain 时不该意外删掉用户的 episode 日志。
    const retentionRaw = flags["episode-retention-days"];
    const retention = retentionRaw === undefined ? 0 : Number(retentionRaw);
    if (!Number.isInteger(retention) || retention < 0) {
      console.error("--episode-retention-days 必须是非负整数");
      return 1;
    }
    const stack = openMemoryStack(root, { episodeRetentionDays: retention });
    try {
      // 约定与 consolidate 一致: 必须显式 --dry-run=true 才只报告
      const report = await stack.consolidate.run({ dryRun: flags["dry-run"] === "true" });
      const prunedEpisodes = stack.episodes.prune();
      // 重新建边: 补齐"建边判据改进后存量条目没跟上"的缺口。
      //
      // 为什么把它放进定期维护 (而不是只留手动命令): 建边**只发生在写入时**, 因此判据一旦改进,
      // 存量条目就永远停在旧口径上 —— 实测真实库曾出现"有 401 条边可建, 库里却只有 20 条"。
      // 依赖用户手动跑一次, 等于这个缺口长期存在。
      //
      // 安全性: relink 只**追加** relations 字段 (不删任何既有边, 含人工显式建的),
      // 且幂等 (重跑 0 新增) —— 与 consolidate 同级别的保守改动。真跑才写盘 (dryRun 只报告)。
      const relink = await relinkAll(stack.store, { dryRun: flags["dry-run"] === "true" });
      const out = {
        command: "maintain",
        applied: report.applied,
        scanned: report.scanned,
        expiring: report.expiring.length,
        prunedEpisodes,
        relinkAdded: relink.added,
        relinkChanged: relink.changed,
      };
      console.log(JSON.stringify(out));
      return 0;
    } finally {
      stack.close();
    }
  }

  if (cmd === "digest") {
    // 摘要是派生视图 (不落盘): 每次按当前库现算, 避免"摘要陈旧"。
    const stack = openMemoryStack(root);
    const digest = await stack.facade.digest(flags["project"] ? { project: flags["project"] } : {});
    console.log("# " + digest.title);
    console.log();
    console.log(digest.summary);
    if (digest.points.length) {
      console.log();
      for (const point of digest.points) console.log("- " + point);
    }
    stack.close();
    return 0;
  }

  if (cmd === "search") {
    // 与人侧交互: 面板已有搜索, CLI 此前没有 —— 而无 GUI 的环境 (远程 shell / 脚本) 只能直连存储,
    // 那会绕过使用层语义 (覆盖率过滤 / 预算 / 可见性 / 降级说明), 拿到与面板不一致的结果。
    const keyword = flags["text"] ?? flags["q"];
    const limit = Number(flags["limit"] ?? 10);
    const stack = openMemoryStack(root);
    const res = stack.facade.recall({
      ...(keyword ? { text: keyword } : {}),
      purpose: "recall",
      limit,
      tokenBudget: Math.max(400, limit * 160),
    });
    if (!res.hits.length) {
      // 与工具同一句口径: 没返回东西 = 库里确实没有 (弃权闸门保证这句成立)。
      console.log("No relevant memory found.");
    } else {
      for (const hit of res.hits) {
        console.log("[" + hit.entry.kind + "][" + hit.entry.id + "] " + hit.entry.content);
        if (hit.channels.length) console.log("    why: " + hit.channels.join("+"));
      }
    }
    if (res.degraded.length) {
      // 降级必须可见 (否则"没搜到"与"引擎降级"分不开)。
      for (const d of res.degraded) console.error("degraded: " + d);
    }
    stack.close();
    return 0;
  }

  if (cmd === "evidence") {
    // 追来源: 一条记忆 → 产生它的原始对话原话 (与工具 memory_evidence / 面板「追来源」同一口径)。
    const id = flags["id"];
    if (!id) {
      console.error("evidence 需要 --id <memoryId>");
      store.close();
      return 1;
    }
    const stack = openMemoryStack(root);
    const chain = await stack.facade.evidenceChain(id);
    if (!chain) {
      console.error("no memory entry with id " + id);
      stack.close();
      return 1;
    }
    console.log("[" + chain.entryId + "] " + chain.content);
    console.log("source: " + chain.source);
    console.log("traceable: " + (chain.traceable ? "yes" : "no"));
    for (const why of chain.reasons) console.log("reason: " + why);
    if (chain.episodes.length) {
      console.log("--- raw turns (untouched) ---");
      for (const ep of chain.episodes) {
        console.log("[" + ep.role + " turn=" + ep.turn + " " + ep.at + "] " + ep.text);
      }
    }
    // 退出码区分"可完整溯源"与"不完整": 脚本据它决定要不要人工核对。
    stack.close();
    return chain.traceable ? 0 : 2;
  }

  if (cmd === "relink") {
    // 给**存量条目**补结构关联边 (只加 relates, 不动内容)。
    // 为什么需要 CLI 入口: 建边只在写入时发生, 因此"判据改进"只对新条目生效 ——
    // 实测真实库 active 154 条而 relates 边仅 20 条 (按当前判据重算可得约 400 条)。
    const stack = openMemoryStack(root);
    const report = await relinkAll(stack.store, {
      dryRun: flags["dry-run"] === "true",
      ...(flags["max-links"] ? { maxLinks: Number(flags["max-links"]) } : {}),
    });
    console.log(JSON.stringify(report, null, 2));
    console.log(
      (report.dryRun ? "[干跑] " : "") +
        "扫描 " + report.scanned + ", 新增边 " + report.added +
        " (涉及 " + report.changed + " 条)" +
        (report.dryRun ? " — 未写盘; 加 --dry-run=false 或去掉该参数即执行" : ""),
    );
    stack.close();
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

  if (cmd === "normalize") {
    // 主动整理: 把老形态的块补成当前形态 (字段补全 + 版本标记)。
    // 默认干跑 —— 先看"会改什么", 再决定是否落盘 (真相文件是人的资产, 不是缓存)。
    const stack = openMemoryStack(root);
    const dryRun = flags["dry-run"] !== "false"; // 默认 true: 必须显式 --dry-run=false 才写入
    const report = stack.normalize.run({ dryRun });
    console.log(JSON.stringify(report, null, 2));
    console.log(
      "整理: 扫描 " +
        report.scanned +
        ", 需改 " +
        report.changed +
        ", 未变 " +
        report.unchanged +
        (report.missing ? ", 真相缺失 " + report.missing : "") +
        (flagApplied(report) ? " (已写入)" : " (干跑, 未写入)"),
    );
    stack.close();
    return 0;
  }

  if (cmd === "mcp" && flags["http"] === "true") {
    // MCP over HTTP: 浏览器内客户端 / 远程部署 / 反向代理后使用。
    // stdio 仍是默认 (本地客户端首选); HTTP 需要显式 --http 打开。
    store.close();
    const stack = openMemoryStack(root, { episodeRetentionDays: 0 });
    const port = Number(flags["port"] ?? 4399);
    const server = await createMcpHttpServer({
      facade: stack.facade,
      port: Number.isFinite(port) && port >= 0 ? port : 4399,
      // 默认只监听回环; 对外暴露必须显式 --host, 并建议同时配 --token。
      ...(flags["host"] ? { host: flags["host"] } : {}),
      ...(flags["token"] ? { token: flags["token"] } : {}),
    });
    console.log("HX-Memory MCP (HTTP) listening on " + server.url);
    console.log("  POST " + server.url + "/mcp    GET " + server.url + "/health");
    if (!flags["token"] && flags["host"] && flags["host"] !== "127.0.0.1") {
      console.warn("警告: 正在对外监听且未设置 --token; 任何能访问该端口的人都能读写你的记忆。");
    }
    // 常驻服务: 等信号再关闭 (Ctrl-C)。
    await new Promise<void>((resolve) => {
      const stop = (): void => resolve();
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
    await server.close();
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
