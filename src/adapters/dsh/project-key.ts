// adapters/dsh/project-key.ts — 会话工作目录 → 项目键 / **项目祖先链** (捕获/绑定/召回/面板共用同一口径)。
//
// 为什么独立成文件: 这个键是**跨层契约** —— 捕获写 project、绑定按 project 匹配、召回按 project
// 过滤、面板按 project 预填。口径一旦分叉, 症状是"记忆明明在, 但换个目录就看不见了",
// 而这类不一致不会让任何测试变红。集中在一处才有可能被钉住。
//
// project 语义演进 (每个坑都是实测出来的):
//   ① session.id (UUID): 自动捕获永远 scope:"agent"、绑定无从填写、项目内召回永远为空。
//   ② 目录名: monorepo 里按子包**碎片化** —— 换个子包工作, 之前沉淀的经验就"不在这个项目里"。
//   ③ 仓库名 (git root 目录名): 子包问题解决, 但**嵌套仓库**又被切成两半 (见下)。当前语义。
//
// ③ 的缺口 (2026-09-18 实测, 本机 HXLoLis 真实结构):
//   HXLoLis 是 git 仓库, 它的 components/ 下挂着 3 个**独立仓库** (gitlink + .gitmodules,
//   实测 git ls-tree 确认): HX-Memory / HX-Workflows / HXLoLi-NaGaMe。
//   (同目录下的 HX-Sagasu 不是独立仓库 —— 无 .git、不在 gitlink 列表, 它是父仓库里的普通
//    目录, 键本来就是 HXLoLis; 实测过才写这一句, 避免把"看起来像组件"当成"是个仓库"。)
//   取 git root 目录名 ⇒ 在 HX-Memory 里得键 "HX-Memory", 在 HXLoLis 里得键 "HXLoLis",
//   同一套代码库的经验互不可见 (实测: HXLoLis 46 条 / HX-Memory 31 条)。
//
// 修法: 键仍是**单个仓库名** (存储格式不变, 老数据不改), 但额外解析出**祖先链**
// (最内层 → 最外层), 由读取期按祖先链判定可见性 —— 详见 kernel/project-lineage.ts
// 的偏序定义与"为什么不能简单合并成一个键"的实测理由 (那会重演跨项目泄漏)。
import { execFileSync } from "node:child_process";
import {
  dirNameOf,
  lineageOfToplevels,
  type ProjectLineage,
} from "../../kernel/project-lineage.ts";

/** 会话的可识别部分 (只取项目键需要的字段: 任何发同类事件的 harness 都可复用)。 */
export interface SessionLike {
  id: string;
  header?: { origin?: string; cwd?: string };
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

/**
 * 向上爬的层数上限 (防御性): 正常嵌套不会超过 3-4 层。
 * 没有它, 一个畸形/循环的 superproject 关系会让会话启动卡在 git 调用上。
 */
const MAX_NESTING_DEPTH = 8;

/**
 * 解析工作目录的祖先链 (无缓存; 缓存由下面两个入口各自维护)。
 *
 * @param git 可注入的执行器, 让这条语义可被单测钉住 (不必真的建嵌套仓库)。
 *   非 git 目录 / git 不可用 / 无权限 → 回退到目录名 (必须有一个稳定的键)。
 */
function resolveLineage(cwd: string, git: (args: readonly string[], cwd: string) => string): ProjectLineage {
  const trimmed = cwd.replace(/[\\/]+$/, "");
  if (!trimmed) return [];
  let top: string | undefined;
  try {
    top = git(["rev-parse", "--show-toplevel"], trimmed).trim() || undefined;
  } catch {
    // 非 git 仓库 / git 不可用 / 无权限 → 下面回退目录名。
  }
  if (!top) {
    const name = dirNameOf(trimmed);
    return name ? [name] : [];
  }
  // 逐层向外: 嵌套仓库 (gitlink) 的父工程由 --show-superproject-working-tree 给出。
  // 普通仓库该命令返回空串, 循环因此自然终止 (不需要额外判据)。
  const paths: string[] = [];
  const seen = new Set<string>();
  let current: string | undefined = top;
  for (let depth = 0; depth < MAX_NESTING_DEPTH && current; depth++) {
    const norm: string = current.replace(/[\\/]+$/, "");
    if (!norm || seen.has(norm)) break;
    seen.add(norm);
    paths.push(norm);
    try {
      current = git(["rev-parse", "--show-superproject-working-tree"], norm).trim() || undefined;
    } catch {
      current = undefined;
    }
  }
  return lineageOfToplevels(paths);
}

/** 每目录只解析一次 (会话开始与预步都会问这个键)。 */
const PROJECT_KEY_CACHE = new Map<string, string>();
/** 祖先链的缓存 (与键缓存分开: 两者的失效/隔离语义各自独立, 见下面的注入参数)。 */
const PROJECT_LINEAGE_CACHE = new Map<string, ProjectLineage>();

/**
 * 会话 → 项目键: 工作目录所属**仓库名** (祖先链最内层); 非仓库回退目录名。
 *
 * 保持**单值**返回是刻意的: 存储里 project 字段因此不变, 全部既有数据与既有调用点
 * (捕获写 project、绑定按 project 匹配、面板预填) 都无需迁移。
 * 需要"父工程的记忆对我是否可见"时请用 lineageOfCwd —— 可见性是读取期的事。
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
  const key = resolveLineage(trimmed, git)[0];
  if (key) cache.set(trimmed, key);
  return key;
}

/**
 * 会话 → **项目祖先链** (最内层在前, 如 ["HX-Memory", "HXLoLis"]); 无工作区时 []。
 *
 * 这是"父工程与子仓库该互相看见多少"的唯一判定输入:
 *   子仓库里工作 → [HX-Memory, HXLoLis] → 自己的 + 父工程的记忆可见;
 *   父工程里工作 → [HXLoLis] → 看不到子仓库私有记忆;
 *   兄弟仓库     → 不在链上 → 严格不可见 (防止重演跨项目泄漏)。
 */
export function lineageOfCwd(
  cwd: string,
  git: (args: readonly string[], cwd: string) => string = defaultGit,
  cache: Map<string, ProjectLineage> = PROJECT_LINEAGE_CACHE,
): ProjectLineage {
  const trimmed = cwd.replace(/[\\/]+$/, "");
  if (!trimmed) return [];
  const cached = cache.get(trimmed);
  if (cached !== undefined) return cached;
  const lineage = resolveLineage(trimmed, git);
  if (lineage.length) cache.set(trimmed, lineage);
  return lineage;
}

/** 会话 → 项目键 (见 projectKeyOfCwd); 无 cwd 时 undefined。 */
export function projectOfSession(session: SessionLike): string | undefined {
  const cwd = session.header?.cwd;
  return typeof cwd === "string" ? projectKeyOfCwd(cwd) : undefined;
}

/** 会话 → 项目祖先链 (见 lineageOfCwd); 无 cwd 时空数组。 */
export function lineageOfSession(session: SessionLike): ProjectLineage {
  const cwd = session.header?.cwd;
  return typeof cwd === "string" ? lineageOfCwd(cwd) : [];
}
