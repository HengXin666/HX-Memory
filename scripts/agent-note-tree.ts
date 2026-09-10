/**
 * Agent Note 树的结构性唯一真相 (lifecycle/class 是封闭集合)。
 *
 * 与 DSH 的 .agents/notes 同构, 但适配本仓库: 中文正文 + 纯 Node 可执行 (strip-only TS, 无 tsx 依赖)。
 * 本模块是纯函数: 只读文件系统, 不做任何写操作, 供各个 gate 复用。
 *
 * 为什么"封闭集合"要写在代码里而不是文档里: 文档可以被忽略, 代码不行 ——
 * 拼错一个目录名 (implemented/refactor/) 会被当场拒绝, 而不是变成一棵没人看的野树。
 */
import { readdirSync, statSync, type Dirent } from "node:fs";
import { resolve, sep } from "node:path";

/** Agent Note 根目录 (仓库内相对路径的唯一来源)。 */
export const agentNoteRoot = resolve(import.meta.dirname, "../.agents/notes");

/** 活跃生命周期 (顶层目录) 的封闭集合。 */
export const AGENT_NOTE_LIFECYCLES = ["proposed", "implemented", "rejected"] as const;

/** 归档区 (只进不改的冻结区, 独立于活跃树)。 */
export const AGENT_NOTE_ARCHIVE = "archived";

/**
 * 决策类别的封闭集合。
 * 增删类别是刻意行为: 必须同时改这里与 .agents/notes/README.md 的分类表。
 */
export const AGENT_NOTE_CLASSES = [
  "feature",
  "bug-fix",
  "simplification",
  "architecture",
  "process",
  "testing",
] as const;

/** 允许直接放在生命周期根目录下的非 Note 文件。 */
const ROOT_ALLOWLIST = new Set(["AGENTS.md", "CLAUDE.md"]);

/** 禁止把 Note 放回历史位置 (防止新 Note 悄悄脱离这棵树)。 */
export const FORBIDDEN_NOTE_ROOTS = ["docs/rfc", "docs/rfcs", "docs/notes", "docs/agent-notes"];

export interface AgentNote {
  lifecycle: string;
  /** 相对 .agents/notes 的路径 (统一用 / 分隔)。 */
  rel: string;
  /** 文件名里的 yyyy-mm-dd。 */
  date: string;
}

export interface WalkResult {
  notes: AgentNote[];
  errors: string[];
}

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/**
 * 遍历 Agent Note 树并同时校验结构。返回合法的 Note 列表与错误列表。
 * **调用方把"错误列表非空"当作致命错误** (exit 1), 而不是警告。
 */
export function walkAgentNoteTree(root: string = agentNoteRoot): WalkResult {
  const notes: AgentNote[] = [];
  const errors: string[] = [];

  // 1) 顶层必须是已知生命周期 (外加归档区)。未知目录会让 Note 隐形, 必须拒绝。
  let topEntries: Dirent[];
  try {
    topEntries = readdirSync(root, { withFileTypes: true });
  } catch {
    return { notes, errors: [`structure: 找不到 ${root} (Agent Note 树不存在)`] };
  }
  for (const entry of topEntries) {
    if (entry.name === "INDEX.md") {
      errors.push(
        "structure: INDEX.md — 禁止集中式 Note 索引 (浏览 lifecycle/class 目录或直接搜索仓库)",
      );
      continue;
    }
    if (entry.name === "README.md" || entry.name === "AGENTS.md" || entry.name === "CLAUDE.md") {
      continue;
    }
    if (entry.isDirectory()) {
      const known =
        (AGENT_NOTE_LIFECYCLES as readonly string[]).includes(entry.name) ||
        entry.name === AGENT_NOTE_ARCHIVE;
      if (!known) {
        errors.push(
          `structure: ${entry.name}/ — 未知生命周期目录 (允许: ${AGENT_NOTE_LIFECYCLES.join(", ")}, 以及 ${AGENT_NOTE_ARCHIVE}/)`,
        );
      }
      continue;
    }
    errors.push(
      `structure: ${entry.name} — Agent Note 根目录只允许 README/AGENTS, 其余文件请放进 lifecycle/class/`,
    );
  }

  // 2) 活跃树: {lifecycle}/{class}/yyyy-mm-dd-topic.md, 深度必须恰好 3。
  for (const lifecycle of [...AGENT_NOTE_LIFECYCLES, AGENT_NOTE_ARCHIVE]) {
    const base = resolve(root, lifecycle);
    for (const file of walkFiles(base)) {
      const rel = file
        .slice(root.length + 1)
        .split(sep)
        .join("/");
      const segments = rel.split("/");
      const base_ = segments[segments.length - 1] ?? "";
      if (segments.length === 2 && ROOT_ALLOWLIST.has(base_)) continue; // implemented/AGENTS.md
      if (!base_.endsWith(".md")) {
        errors.push(`structure: ${rel} — Agent Note 只收 .md 文件`);
        continue;
      }
      const cls = segments[1];
      if (segments.length !== 3 || cls === undefined) {
        errors.push(
          `structure: ${rel} — 期望 {lifecycle}/{class}/file.md (实际深度 ${segments.length})`,
        );
        continue;
      }
      if (!(AGENT_NOTE_CLASSES as readonly string[]).includes(cls)) {
        errors.push(
          `structure: ${rel} — 未知类别目录 "${cls}" (允许: ${AGENT_NOTE_CLASSES.join(", ")})`,
        );
        continue;
      }
      if (!/^\d{4}-\d{2}-\d{2}-.+\.md$/.test(base_)) {
        errors.push(`structure: ${rel} — 文件名必须是 yyyy-mm-dd-topic.md`);
        continue;
      }
      notes.push({ lifecycle, rel, date: base_.slice(0, 10) });
    }
  }
  notes.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return { notes, errors };
}

/** 目录是否存在 (禁止路径检查用)。 */
export function pathExists(relFromRepoRoot: string): boolean {
  try {
    return statSync(resolve(agentNoteRoot, "../..", relFromRepoRoot)).isDirectory();
  } catch {
    return false;
  }
}

/** 相对仓库根解析路径 (测试与 gate 共用)。 */
export function repoPath(relFromRepoRoot: string): string {
  return resolve(agentNoteRoot, "../..", relFromRepoRoot);
}
