/**
 * `pnpm run notes:new` — 交互式/参数式新建一篇 Agent Note (脚手架)。
 *
 * 为什么需要它: 硬约束如果没有低摩擦的入口, 就会被绕过 (写成"随便放个文件"再被 gate 拒绝)。
 * 脚手架负责把所有机械部分做对: 路径、目录、头部三行、按生命周期的章节骨架 —— 人只填内容。
 *
 * 用法:
 *   pnpm run notes:new -- --lifecycle implemented --class architecture --title "四层切面"
 *   pnpm run notes:new -- --lifecycle proposed --class testing --title "变异测试" --slug mutation-testing
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { AGENT_NOTE_CLASSES, AGENT_NOTE_LIFECYCLES, agentNoteRoot } from "./agent-note-tree.ts";

interface Args {
  lifecycle?: string;
  class?: string;
  title?: string;
  slug?: string;
  date?: string;
}

function parse(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--lifecycle") out.lifecycle = argv[++i];
    else if (arg === "--class") out.class = argv[++i];
    else if (arg === "--title") out.title = argv[++i];
    else if (arg === "--slug") out.slug = argv[++i];
    else if (arg === "--date") out.date = argv[++i];
  }
  return out;
}

/** 由标题生成 slug (中文标题无法转拼音, 因此要求显式提供 --slug)。 */
function asciiSlug(input: string): string | null {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length >= 3 ? slug : null;
}

function skeleton(lifecycle: string, title: string): string {
  const header = [
    `# Agent Note: ${title}`,
    "",
    lifecycle === "rejected" ? "Status: rejected — <一句话说明为什么否掉>" : `Status: ${lifecycle}`,
    "",
  ];
  const body =
    lifecycle === "proposed"
      ? [
          "## Problem",
          "",
          "<!-- 动机: 要能脱离方案独立读懂。现状哪里不对, 为什么值得改。 -->",
          "",
          "## Proposal",
          "",
          "<!-- 打算怎么做 (允许未来时态)。 -->",
          "",
          "## Alternatives considered",
          "",
          "<!-- 强制: 每个真实考虑过的替代方案一段, 粗体开头 + 为什么它输了。 -->",
          "",
          "## Acceptance criteria",
          "",
          "<!-- 什么可观察状态算完成 (要能被测试或命令验证)。 -->",
          "",
          "## Risks",
          "",
          "<!-- 可能出什么错 + 这次明确放弃了什么。 -->",
          "",
        ]
      : lifecycle === "implemented"
        ? [
            "## Problem",
            "",
            "<!-- 动机: 要能脱离方案独立读懂。 -->",
            "",
            "## Decision",
            "",
            "<!-- 用现在时描述已发布的事实 (不要写成计划或将来的语气)。 -->",
            "",
            "## Alternatives considered",
            "",
            "<!-- 强制: 每个真实考虑过的替代方案一段, 粗体开头 + 为什么它输了。 -->",
            "",
            "## Consequences",
            "",
            "<!-- 这次取舍付出了什么、换来了什么。 -->",
            "",
            "## Testing",
            "",
            "<!-- 由什么钉住: 测试文件/门禁/评测脚本。 -->",
            "",
          ]
        : [
            "## Problem",
            "",
            "<!-- 当初要解决什么。 -->",
            "",
            "## Proposal",
            "",
            "<!-- 被否掉的那个提案 (冻结保留, 结论写在 Status 行)。 -->",
            "",
            "## Alternatives considered",
            "",
            "<!-- 最终采纳了什么, 为什么。 -->",
            "",
          ];
  return [...header, ...body].join("\n");
}

const args = parse(process.argv.slice(2));
const usage =
  "用法: pnpm run notes:new -- --lifecycle <proposed|implemented|rejected> --class <" +
  AGENT_NOTE_CLASSES.join("|") +
  "> --title <标题> [--slug ascii-slug] [--date yyyy-mm-dd]";

if (!args.lifecycle || !(AGENT_NOTE_LIFECYCLES as readonly string[]).includes(args.lifecycle)) {
  console.error("错误: --lifecycle 必须是 " + AGENT_NOTE_LIFECYCLES.join(" | "));
  console.error(usage);
  process.exit(1);
}
if (!args.class || !(AGENT_NOTE_CLASSES as readonly string[]).includes(args.class)) {
  console.error("错误: --class 必须是 " + AGENT_NOTE_CLASSES.join(" | "));
  console.error(usage);
  process.exit(1);
}
if (!args.title?.trim()) {
  console.error("错误: 缺少 --title");
  console.error(usage);
  process.exit(1);
}

const date = args.date ?? new Date().toISOString().slice(0, 10);
if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
  console.error("错误: --date 必须是 yyyy-mm-dd");
  process.exit(1);
}
const slug = args.slug?.trim() || asciiSlug(args.title);
if (!slug) {
  // 中文标题转不出 ascii slug: 要求显式给 --slug, 否则文件名会变成一串中文 (可接受但不易引用)。
  console.error("提示: 标题无法自动生成 ascii slug, 请用 --slug 指定 (如 --slug four-layer-seams)");
  process.exit(1);
}

const dir = resolve(agentNoteRoot, args.lifecycle, args.class);
const file = resolve(dir, `${date}-${slug}.md`);
if (existsSync(file)) {
  console.error("错误: 文件已存在: " + file);
  process.exit(1);
}
mkdirSync(dir, { recursive: true });
writeFileSync(file, skeleton(args.lifecycle, args.title.trim()), "utf8");
console.log("已创建: " + file.slice(resolve(agentNoteRoot, "../..").length + 1));
console.log(
  "下一步: 填内容 (Alternatives considered 是必填), 然后跑 pnpm run verify-agent-note-format",
);
