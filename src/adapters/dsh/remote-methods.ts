// src/adapters/dsh/remote-methods.ts — gateway 暴露的 Remote 方法名单一来源。
//
// 为什么要集中: 宿主 Typert gateway 按"namespace/method"路由, 客户端把方法名写错
// (或服务端改名) 的结果是静默 404 —— 没有编译错误, 也没有运行时异常。
// 客户端调用入口 (client/rpc.ts) 用这个表做运行时校验, 测试再拿它和 gateway 的
// @Remote 字面量做集合比对。

export const HXMEM_REMOTE_METHODS = [
  "reviewQueue",
  "runGeneralization",
  "generalizationStatus",
  "currentProject",
  "confirmProposal",
  "rejectProposal",
  "listBindings",
  "saveBindings",
  "listInvocations",
  "recentCaptures",
  "deleteEntry",
  "memoryQuery",
  // 主动整理 (无损迁移): 面板先 dryRun 看清单, 再点确认写回。
  "normalizeMemory",
  // 待裁决的矛盾集合: 此前 keep-both 只写边、没有任何入口能列出来。
  "contradictions",
  // 被 agent 负面标注过的记忆 (标注会降权排序, 必须可解释)。
  "flaggedMemories",
] as const;

export type HxMemoryRemoteMethod = (typeof HXMEM_REMOTE_METHODS)[number];

export function isHxMemoryRemoteMethod(value: string): value is HxMemoryRemoteMethod {
  return (HXMEM_REMOTE_METHODS as readonly string[]).includes(value);
}
