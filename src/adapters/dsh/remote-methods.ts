// src/adapters/dsh/remote-methods.ts — gateway 暴露的 Remote 方法名单一来源。
//
// 为什么要集中: 宿主 Typert gateway 按"namespace/method"路由, 客户端把方法名写错
// (或服务端改名) 的结果是静默 404 —— 没有编译错误, 也没有运行时异常。
// 客户端调用入口 (client/rpc.ts) 用这个表做运行时校验, 测试再拿它和 gateway 的
// @Remote 字面量做集合比对。

export const HXMEM_REMOTE_METHODS = [
  "reviewQueue",
  // 人审展开: 提议只带 covers 的 id, 原文必须能取回来 —— 否则"该不该确认"只能靠猜。
  "entriesByIds",
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
  // 注入调度账本: "为什么这一轮注入/没注入" —— 触发层设计目标的兑现处。
  "scheduleLog",
  // 后台维护 (P3 调度器): "它最近跑了没有/成功没有/下次什么时候" —— 否则只能相信它。
  "maintenance",
  // 捕获耗时账本: "沉淀有没有把这一轮拖慢、拖在哪一段、为什么没沉淀" —— 否则只能靠猜。
  "captureLog",
] as const;

export type HxMemoryRemoteMethod = (typeof HXMEM_REMOTE_METHODS)[number];

export function isHxMemoryRemoteMethod(value: string): value is HxMemoryRemoteMethod {
  return (HXMEM_REMOTE_METHODS as readonly string[]).includes(value);
}
