/**
 * Gate: 非平凡改动必须带一篇 Agent Note (硬约束, 本仓库比 DSH 更进一步)。
 *
 * DSH 靠"AGENTS.md 里写清楚 + 人/agent 自觉"来保证这条, CI 只校验已有 Note 的格式与分类。
 * 本脚本把它变成**可机械判定**的规则: 给定一次改动 (默认 HEAD 与工作区/上游的 diff),
 * 若改到了"非平凡面"却没有新增/修改任何 Agent Note, 则失败。
 *
 * 判定口径 (与 .agents/notes/README.md § 何时写一篇 一致):
 *   非平凡面 = src/**  .agents/rules/**  scripts/**  dsh/**  .github/workflows/**  package.json  tsconfig*.json
 *   豁免     = 纯文档 (README/docs/tests 之外的 md)、测试、CI 之外的杂项; 以及显式标注 [trivial] 的提交
 *   满足条件 = 本次改动里新增或修改了 .agents/notes 下 (proposed/implemented/rejected) 的任一 .md 文件
 *
 * 用法:
 *   node --experimental-strip-types scripts/verify-agent-note-coverage.ts                 # 工作区 vs HEAD
 *   ... --base origin/main        # PR 场景: 与基线比较
 *   ... --staged                  # 只看到暂存区 (pre-commit 用)
 *   ... --range A..B              # 任意范围
 *   ... --allow-missing           # 显式放行 (打印警告, 用于纯机械改动)
 */
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 非平凡面: 命中即要求带 Note。 */
const NON_TRIVIAL = [
  /^src\//,
  /^\.agents\/rules\//,
  /^scripts\//,
  /^dsh\//,
  /^\.github\/workflows\//,
  /^package\.json$/,
  /^tsconfig[^/]*\.json$/,
];

/** 满足条件: 出现这些改动即视为"带了 Note"。 */
const NOTE_PATTERN = /^\.agents\/notes\/(proposed|implemented|rejected)\/.+\.md$/;

/** 豁免: 纯测试/纯文档 (非规则类) 改动不要求 Note。 */
const EXEMPT = [/^tests\//, /^docs\//, /^\.agents\/skills\//, /^README/, /^\.agents\/notes\//];

interface Options {
  base?: string;
  range?: string;
  staged: boolean;
  allowMissing: boolean;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { staged: false, allowMissing: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--staged") opts.staged = true;
    else if (arg === "--allow-missing") opts.allowMissing = true;
    else if (arg === "--base") opts.base = argv[++i];
    else if (arg === "--range") opts.range = argv[++i];
  }
  return opts;
}

function git(args: string[]): string {
  try {
    return execFileSync("git", args, { encoding: "utf8" });
  } catch {
    return "";
  }
}

/** 收集本次改动的文件路径 (去重)。 */
function changedFiles(opts: Options): string[] {
  const files = new Set<string>();
  const add = (raw: string): void => {
    for (const line of raw.split("\n")) {
      const file = line.trim();
      if (file) files.add(file);
    }
  };
  if (opts.range) {
    add(git(["diff", "--name-only", opts.range]));
  } else if (opts.staged) {
    add(git(["diff", "--name-only", "--cached"]));
  } else {
    if (opts.base) add(git(["diff", "--name-only", opts.base + "...HEAD"]));
    add(git(["diff", "--name-only", "HEAD"]));
    add(git(["diff", "--name-only", "--cached"]));
    add(git(["ls-files", "--others", "--exclude-standard"]));
  }
  return [...files].sort();
}

export interface CoverageVerdict {
  ok: boolean;
  /** 命中"非平凡面"且未被豁免的文件。 */
  nonTrivial: string[];
  /** 本次改动是否带了 Agent Note。 */
  noteTouched: boolean;
}

/**
 * 纯函数判定 (导出是为了可测试): 给定改动文件列表, 判断是否满足"非平凡改动必须带 Note"。
 * 一个"永远通过"的 gate 比没有 gate 更糟 —— 所以判定逻辑必须能被逐个断言。
 */
export function classifyChange(files: readonly string[]): CoverageVerdict {
  const noteTouched = files.some((file) => NOTE_PATTERN.test(file));
  const nonTrivial = files.filter(
    (file) => NON_TRIVIAL.some((re) => re.test(file)) && !EXEMPT.some((re) => re.test(file)),
  );
  return { ok: noteTouched || nonTrivial.length === 0, nonTrivial, noteTouched };
}

/** CLI 驱动 (仅在直接执行时运行)。 */
function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  const files = changedFiles(opts);
  const verdict = classifyChange(files);
  const { noteTouched, nonTrivial } = verdict;

  if (files.length === 0) {
    console.log("verify-agent-note-coverage: 本次没有改动, 跳过。");
    process.exit(0);
  }

  if (noteTouched) {
    console.log(
      `verify-agent-note-coverage: OK (改动 ${files.length} 个文件, 其中包含 Agent Note; 非平凡面 ${nonTrivial.length} 个)。`,
    );
    process.exit(0);
  }

  if (nonTrivial.length === 0) {
    console.log(
      `verify-agent-note-coverage: OK (改动 ${files.length} 个文件, 未触及非平凡面: src/rules/scripts/dsh/workflows/package/tsconfig)。`,
    );
    process.exit(0);
  }

  const message =
    `verify-agent-note-coverage: 改动了非平凡面但没有 Agent Note。\n` +
    `  非平凡文件 (${nonTrivial.length}): ${nonTrivial.slice(0, 8).join(", ")}${nonTrivial.length > 8 ? " …" : ""}\n` +
    `  要求: 本次改动里新增或修改一篇 .agents/notes/{proposed|implemented|rejected}/<class>/yyyy-mm-dd-topic.md\n` +
    `  怎么写: 见 .agents/notes/README.md (proposed 用 Proposal/Acceptance criteria/Risks, implemented 用 Decision/Consequences; Alternatives considered 必填)\n` +
    `  纯机械改动可显式放行: 加 --allow-missing`;

  if (opts.allowMissing) {
    console.warn(message.replace(": 改动了", ": 警告 (已用 --allow-missing 放行) — 改动了"));
    process.exit(0);
  }
  console.error(message);
  process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
