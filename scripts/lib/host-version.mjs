// scripts/lib/host-version.mjs — 门禁要装的宿主版本: 唯一来源是 package.json 的 dsh.host。
//
// 为什么需要它 (2026-09-14 实测): .github/workflows/boot-smoke.yml 里曾写死
// `npm install -g @deepseek-ai/dsh@0.1.2-rc.1`, 而线上实际运行的宿主是 0.1.5-rc.1。
// 门禁因此长期在测一个**不受支持**的组合, 而它漏掉的缺陷恰恰是宿主版本差异
// (跨实例的 Typert marker → 端点整组 404) —— "测另一个版本"的门禁不可能发现这种问题。
//
// 口径 (2026-09-14 决定): **装用户会装到的那一个, 并且它必须落在受支持范围内**。
//   - "用户会装到的" = dist-tag `latest` (执行 `npm install -g @deepseek-ai/dsh` 的结果),
//     因为用户遇到的就是它。曾经的缺陷正是 latest 从 0.1.1-rc.2 跳到 0.1.5-rc.1 时发生的。
//   - "必须落在范围内" = latest 必须被 `package.json` 的 `dsh.host` 接受。上游把 latest 推到
//     范围之外时**大声失败**, 而不是悄悄换一个版本去测 —— 那个版本差异要人来决定怎么处理。
//   - 刻意**不是**"装范围内的最高版": `^0.1.5-rc.1` 会解析到 `0.1.5-rc.2` (dist-tag `next`),
//     那是默认安装拿不到的版本, 测它等于又回到"测一个用户没有的组合"。
//
// 解析与判断都交给 npm 自己的解析器 (`npm view <name>@<spec> version`), 不引入 semver 依赖
// (本仓库没有, 也不该为一段胶水加一个), 而且判定规则与 "`npm install` 会不会装它"天然一致。
//
// 用法: node scripts/lib/host-version.mjs [package.json 路径]
//   输出: 解析到的版本 (单个); 越界或解析不到时非零退出并说明该改哪里。
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const HOST_PACKAGE = "@deepseek-ai/dsh";

/** 从 package.json 的 dsh.host 读宿主范围; 缺失即报错 (不猜一个默认值出来)。 */
export function hostRange(manifest) {
  const range = manifest?.dsh?.host;
  if (typeof range !== "string" || range.trim() === "") {
    throw new Error(
      "package.json: 缺少 dsh.host (门禁要装的宿主版本范围); 见 scripts/lib/host-version.mjs",
    );
  }
  return range.trim();
}

function npmView(args, exec) {
  const raw = exec("npm", ["view", ...args, "--json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(raw);
}

function asVersions(parsed) {
  return (Array.isArray(parsed) ? parsed : [parsed]).filter((v) => typeof v === "string");
}

/** 真实装包的位置语义: `latest` 这个 dist-tag 指向哪个版本。 */
export function latestHostVersion({ exec = execFileSync } = {}) {
  const version = asVersions(npmView([HOST_PACKAGE + "@latest", "version"], exec))[0];
  if (version === undefined) throw new Error("npm 没有给出 " + HOST_PACKAGE + "@latest 的版本");
  return version;
}

/** 该版本是否被范围接受 (用 npm 的解析器判定, 不用自己实现的 semver)。 */
export function isInRange(range, version, { exec = execFileSync } = {}) {
  const inRange = asVersions(npmView([HOST_PACKAGE + "@" + range, "version"], exec));
  return inRange.includes(version);
}

/**
 * 门禁要装的宿主版本 = latest, 且必须被 dsh.host 接受。
 * 越界时抛错: 这是"用户被推到插件不支持的宿主上"的可观测信号, 必须有人处理,
 * 不允许降级成"那就装范围内的另一个版本" —— 那正是这次要修掉的失败模式。
 */
export function resolveHostVersion(manifest, { exec = execFileSync } = {}) {
  const range = hostRange(manifest);
  const version = latestHostVersion({ exec });
  if (!isInRange(range, version, { exec })) {
    throw new Error(
      "上游 latest 是 " +
        HOST_PACKAGE +
        "@" +
        version +
        ", 但 package.json 的 dsh.host (" +
        range +
        ") 不接受它 —— 用户装到的是插件不支持的宿主。\n" +
        "  要么把插件适配到该宿主并把 dsh.host / peerDependencies 一起抬高 (并跑一次真机冒烟),\n" +
        "  要么明确保留旧范围, 但那样 CI 就会停下 —— 这正是要你看见的信号。",
    );
  }
  return version;
}

function main(argv) {
  const manifestPath = resolve(argv[0] ?? "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  process.stdout.write(resolveHostVersion(manifest) + "\n");
  return 0;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "")) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error("host-version: " + String(error instanceof Error ? error.message : error));
    process.exitCode = 1;
  }
}
