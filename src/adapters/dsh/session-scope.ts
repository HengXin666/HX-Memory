// adapters/dsh/session-scope.ts — 会话 → 工作区上下文 (项目键 + 项目祖先链)。
//
// 为什么独立成文件 (§710 行数上限的又一次触发): 它是**跨层契约的一小块** ——
// binder 的绑定匹配、检索的可见性、触发缓存的键、工具的 scope 过滤全都读它,
// 因此它的形状必须显式、可单独审视。放在 runtime.ts 里时它只是一段便利函数,
// 而它实际决定的是"哪些项目的记忆能被哪个会话看见"。
import { lineageOfSession, projectOfSession, type SessionLike } from "./project-key.ts";
import type { ProjectScopeArg } from "../../kernel/project-lineage.ts";

/**
 * 会话 → 工作区上下文 (项目键 + 项目祖先链), 交给 binder/检索/缓存使用。
 *
 * 无 cwd 时返回 undefined —— 语义是"不知道是哪个工作区", 调用方据此只给跨项目规则
 * (绝不退化成"所有项目的都给", 那是实测过的泄漏)。
 */
export function scopeOfSession(session: SessionLike): ProjectScopeArg | undefined {
  const lineage = lineageOfSession(session);
  const project = lineage[0] ?? projectOfSession(session);
  if (!project) return undefined;
  return { project, lineage };
}
