// adapters/codex/cli-args.ts — CLI 参数解析 (2026-11-02 从 cli.ts 拆出, verify-structure 400 行约束)。

/**
 * 解析 --key value 与布尔开关 --flag。
 * 注意: 末尾的 --flag 没有后继值时必须是 "true" 而不是 "" 
 * 后者在 `if (flags["flag"])` 里是假值, 会把"打开开关"静默解释成"没打开" (真实踩过)。
 */
/** 报告里"是否真的写入了"的可读判定 (dryRun 与 applied 组合, 避免两处措辞漂移)。 */
export function flagApplied(report: { dryRun: boolean; applied: boolean }): boolean {
  return !report.dryRun && report.applied;
}

export function parseArgv(argv: string[]): Record<string, string> {
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
