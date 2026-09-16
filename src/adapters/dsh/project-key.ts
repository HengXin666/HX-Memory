// adapters/dsh/project-key.ts — 会话工作目录 → 项目键 (捕获/绑定/召回/面板共用同一口径)。
//
// 为什么独立成文件: 这个键是**跨层契约** —— 捕获写 project、绑定按 project 匹配、召回按 project
// 过滤、面板按 project 预填。口径一旦分叉, 症状是"记忆明明在, 但换个目录就看不见了",
// 而这类不一致不会让任何测试变红。集中在一处才有可能被钉住。
//
// project 语义 (2026-09 修正): 项目键 = 会话工作目录所属**仓库名** (git root 目录名, 非仓库回退目录名)。
// 此前用的是 session.id (UUID), 导致自动捕获永远是 scope:"agent"、绑定面板无从填写、项目内召回永远为空;
// 后来改用目录名, 又在 monorepo 里按子包碎片化 —— 两个坑都记在 projectKeyOfCwd 上。
import { execFileSync } from "node:child_process";

/** 会话的可识别部分 (只取项目键需要的字段: 任何发同类事件的 harness 都可复用)。 */
export interface SessionLike {
  id: string;
  header?: { origin?: string; cwd?: string };
}

/** 目录名 (路径最后一段), 空串/纯分隔符时 undefined。 */
function dirNameOf(path: string): string | undefined {
  const trimmed = path.replace(/[\\/]+$/, "");
  if (!trimmed) return undefined;
  const name = trimmed.split(/[\\/]/).pop();
  return name && name.length ? name : undefined;
}

/** 默认 git 执行器 (失败抛错, 由调用方回退)。超时 3s: 解析项目键不能拖住会话启动。 */
function defaultGit(args: readonly string[], cwd: string): string {
  return execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 3000,
  });
}

/** 每目录只解析一次 (会话开始与预步都会问这个键)。 */
const PROJECT_KEY_CACHE = new Map<string, string>();

/**
 * 会话 → 项目键: 工作目录所属**仓库名** (git root 的目录名); 非仓库回退目录名。
 *
 * 为什么不用目录名当项目键 (2026-09 修正): monorepo 里同一仓库的每个子包是一个目录。
 * 用目录名会让记忆按子包**碎片化** —— 在同一个仓库的另一个目录继续工作时, 之前沉淀的
 * 项目经验就"不在这个项目里"了。git root 在同一仓库的所有子目录上恒定, 因此键稳定,
 * 而跨仓库仍然隔离; 非 git 目录退化为原来的目录名语义 (至少有一个稳定的键)。
 *
 * 可注入的 git 执行器是为了让这条语义可被单测钉住, 不必真的建仓库。
 */
export function projectKeyOfCwd(
  cwd: string,
  git: (args: readonly string[], cwd: string) => string = defaultGit,
  cache: Map<string, string> = PROJECT_KEY_CACHE,
): string | undefined {
  const trimmed = cwd.replace(/[\\/]+$/, "");
  if (!trimmed) return undefined;
  const cached = cache.get(trimmed);
  if (cached !== undefined) return cached;
  let key: string | undefined;
  try {
    key = dirNameOf(git(["rev-parse", "--show-toplevel"], trimmed).trim());
  } catch {
    // 非 git 仓库 / git 不可用 / 无权限 → 回退目录名 (不能没有项目键)。
  }
  if (!key) key = dirNameOf(trimmed);
  if (key) cache.set(trimmed, key);
  return key;
}

/** 会话 → 项目键 (见 projectKeyOfCwd); 无 cwd 时 undefined。 */
export function projectOfSession(session: SessionLike): string | undefined {
  const cwd = session.header?.cwd;
  return typeof cwd === "string" ? projectKeyOfCwd(cwd) : undefined;
}
