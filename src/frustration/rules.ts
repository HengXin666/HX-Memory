// src/frustration/rules.ts — 评审产出的规则库 + 按适用范围匹配 (PLAN.md J3.5)。
//
// 存储: <记忆根>/rules/lessons/<id>.json, 一条规则一个文件。
// 为什么不用一个大文件: 新增规则只会新建文件, 不存在读-改-写, 多个 DSH 窗口同时入库也不会互相覆盖
// (P0 修过的 D1/D17 那一类问题在这里从结构上不会发生)。写法仍是临时文件 + fsync + rename。
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join, relative, sep } from "node:path";
import type { Lesson } from "./review.ts";

export class LessonStore {
  readonly dir: string;
  constructor(root: string) {
    this.dir = join(root, "rules", "lessons");
  }

  save(lesson: Lesson): void {
    mkdirSync(this.dir, { recursive: true });
    const path = join(this.dir, lesson.id + ".json");
    const tmp = path + ".tmp-" + process.pid + "-" + randomBytes(6).toString("hex");
    const fd = openSync(tmp, "w");
    try {
      writeSync(fd, JSON.stringify(lesson, null, 2) + "\n");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      renameSync(tmp, path);
    } catch (error) {
      rmSync(tmp, { force: true });
      throw error;
    }
  }

  list(): Lesson[] {
    if (!existsSync(this.dir)) return [];
    const out: Lesson[] = [];
    for (const name of readdirSync(this.dir).sort()) {
      if (!name.endsWith(".json")) continue;
      try {
        out.push(JSON.parse(readFileSync(join(this.dir, name), "utf8")) as Lesson);
      } catch {
        // 坏文件跳过, 不让一条规则拖垮整轮注入。
      }
    }
    return out;
  }

  /** 适用于这个工作位置的规则: 仓库相同 (或规则不限仓库), 且当前目录落在规则的目录前缀下。 */
  match(where: { repo: string; cwd: string }): Lesson[] {
    return this.list().filter((l) => appliesTo(l, where));
  }
}

export function appliesTo(lesson: Lesson, where: { repo: string; cwd: string }): boolean {
  const { repo, dir } = lesson.scope;
  if (repo && repo !== where.repo) return false;
  if (!dir) return true;
  if (!where.repo) return false;
  const rel = relative(where.repo, where.cwd).split(sep).join("/");
  return rel === dir || rel.startsWith(dir + "/") || dir.startsWith(rel === "" ? "" : rel + "/") || rel === "";
}

/** 注入给主 agent 的规则文本 (一条一段)。 */
export function formatLesson(l: Lesson): string {
  const scope = [l.scope.repo ? "仓库 " + l.scope.repo : "所有仓库", l.scope.dir ? "目录 " + l.scope.dir : "", "任务 " + l.scope.taskType]
    .filter(Boolean)
    .join(", ");
  const ev = l.evidence
    .slice(0, 2)
    .map((e) => "第" + e.turn + "轮「" + (e.quote.length > 80 ? e.quote.slice(0, 80) + "…" : e.quote) + "」")
    .join("; ");
  return "· 错在: " + l.where + "\n  改为: " + l.wanted + "\n  适用: " + scope + "\n  依据: " + ev;
}
