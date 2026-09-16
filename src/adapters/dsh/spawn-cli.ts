// adapters/dsh/spawn-cli.ts — 后台维护任务的**执行器** (启动 Codex CLI 的子进程)。
//
// 为什么要子进程而不是直接调服务: 维护任务是"批量、可能长时间、会写真相文件"的工作,
// 直接在当前进程里跑会与宿主的捕获写入并发改写同一批 Markdown 文件 —— 两个进程同时
// upsert 同一个块会丢写。子进程 + **空闲窗** (见 scheduler.ts) 把这件事变成安全的。
//
// 解析顺序 (两条都要支持, 因为开发态与安装态的文件扩展名不同):
//   1. 环境变量 HX_MEMORY_CLI (显式覆盖; 测试用它指向 stub —— 否则单元测试会去启动真 CLI);
//   2. 与本文件同级的 ../codex/cli.js (构建产物 dist/adapters/codex/cli.js);
//   3. ../codex/cli.ts (开发态, 用 --experimental-strip-types 直接跑源码)。
// 都找不到 → 明确返回"没有可执行的 CLI", 由调用方记一条可观测的日志 (而不是静默不维护)。
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

/**
 * CLI 侧真正执行的**唯一**子命令。
 *
 * 为什么是"一条命令"而不是"任务名数组": 第一版把 `["consolidate", "prune"]` 当作 argv 传,
 * 而 CLI 的 `main` 只认第一个位置参数 (`argv[0]`) —— 第二个被当成多余的裸参数**静默忽略**,
 * 进程照常 `exit 0`。于是 episode 清理从未执行过, 而记录显示"成功"。
 * 这是最坏的一类失效: 看起来在工作, 实际什么都没做, 且没有任何信号。
 *
 * 现在 CLI 只暴露一个 `maintain` (它自身按顺序做 consolidate → episodes.prune),
 * 子进程只可能说"跑 maintain", 不存在"某个任务名不是真子命令"的空间。
 */
export const MAINTENANCE_COMMAND = "maintain";

export interface CliRunResult {
  ok: boolean;
  /** 人类可读的结论 (exit code / 超时 / 找不到 CLI)。 */
  detail: string;
  /**
   * 子进程输出尾部。**成功时也保留**: maintain 会打一行 JSON (`applied/scanned/prunedEpisodes`),
   * 而"跑了但什么都没做"与"跑了并清理了 N 条"在退出码上完全一样 —— 只有这行 JSON 能区分。
   * (踩过: 只存失败输出, 于是"每次都成功"的记录掩盖了"每次都空跑"。)
   */
  output: string;
  elapsedMs: number;
}

export interface CliRunOptions {
  /**
   * 记忆根目录 (**必须显式传**)。踩过的坑: 第一版 execute 只传了任务名, 于是 CLI 收不到
   * `--root`、直接打 usage 并 exit 1 —— 维护每次"跑了但什么都没做", 而记录里只有
   * `exit:1` 一个数字, 看不出原因。根目录是**参数**而不是环境默认值, 因为子进程的
   * 默认值 ($DSH_HOME/~/.dsh) 未必等于插件实例正在用的那个 (测试与多实例场景)。
   */
  root: string;
  timeoutMs: number;
  /**
   * episode 保留天数 (**必须显式传**)。
   *
   * 踩过的第三个同类坑: `prune` 在子进程里是**静默 no-op**。`EpisodeStore` 的保留期默认是
   * "0 = 永久", 而子进程自建的 stack 拿不到用户在面板里配的值 —— 于是每次维护都"成功"、
   * `prunedEpisodes: 0`, episode 日志永不清理。保留期是**用户的设置**, 只能由父进程告诉它。
   */
  episodeRetentionDays: number;
}

/** 输出尾部上限: 排查只需要末尾的报错, 不需要整份输出 (环形缓冲里也不该塞大字符串)。 */
const MAX_OUTPUT = 4000;

export interface CliRunner {
  /** 可执行的 CLI (没有则 null)。 */
  available(): { cmd: string; args: string[] } | null;
  run(opts: CliRunOptions): Promise<CliRunResult>;
}

/** 定位 CLI 可执行文件的 argv 前缀 (纯函数, 不碰文件时返回 null)。 */
export function resolveCli(): { cmd: string; args: string[] } | null {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const override = process.env.HX_MEMORY_CLI;
  if (override) {
    const isTs = override.endsWith(".ts");
    const args = isTs ? ["--experimental-strip-types", override] : [override];
    return { cmd: process.execPath, args };
  }
  for (const rel of ["../codex/cli.js", "../codex/cli.ts"]) {
    const path = new URL(rel, import.meta.url).pathname;
    if (!existsSync(path)) continue;
    const isTs = rel.endsWith(".ts");
    return {
      cmd: process.execPath,
      args: isTs ? ["--experimental-strip-types", path] : [path],
    };
  }
  // 开发态: 源码就在仓库里, 但当前文件可能是构建产物 (dist/...) —— 相对仓库根再试一次。
  const srcCandidate = new URL("../../src/adapters/codex/cli.ts", import.meta.url).pathname;
  if (existsSync(srcCandidate)) {
    return { cmd: process.execPath, args: ["--experimental-strip-types", srcCandidate] };
  }
  void here;
  return null;
}

/**
 * 造一个执行器。**永不抛出**: 失败一律折成 `{ ok: false }` ——
 * 后台维护的失败绝不能变成未处理异常 (那会让宿主致命退出)。
 */
export function makeCliRunner(): CliRunner {
  return {
    available: () => resolveCli(),
    run: (opts) =>
      new Promise<CliRunResult>((resolve) => {
        const cli = resolveCli();
        if (!cli) {
          resolve({ ok: false, detail: "cli-not-found", output: "", elapsedMs: 0 });
          return;
        }
        const started = Date.now();
        const argv = [
          ...cli.args,
          MAINTENANCE_COMMAND,
          "--root",
          opts.root,
          "--episode-retention-days",
          String(opts.episodeRetentionDays),
        ];
        const child = spawn(cli.cmd, argv, {
          stdio: ["ignore", "pipe", "pipe"],
        });
        let out = "";
        const keep = (chunk: unknown): void => {
          out += String(chunk);
          if (out.length > MAX_OUTPUT) out = out.slice(-MAX_OUTPUT);
        };
        child.stdout?.on("data", keep);
        child.stderr?.on("data", keep);
        let settled = false;
        const settle = (result: CliRunResult): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(result);
        };
        const timer = setTimeout(
          () => {
            try {
              // 挂死的维护必须被强制结束: 它是后台任务, 不许无限占用宿主资源。
              child.kill("SIGKILL");
            } catch {
              // 已经退出
            }
          },
          Math.max(1000, opts.timeoutMs),
        );
        child.on("error", (error) => {
          settle({ ok: false, detail: "spawn-error: " + String(error), output: out.trim(), elapsedMs: Date.now() - started });
        });
        child.on("close", (code, signal) => {
          settle({
            ok: code === 0,
            // detail 必须带**可读原因**, 否则失败只剩一个数字无从排查 (踩过)。
            detail: signal ? "killed:" + signal : "exit:" + String(code),
            output: out.trim(),
            elapsedMs: Date.now() - started,
          });
        });
      }),
  };
}
