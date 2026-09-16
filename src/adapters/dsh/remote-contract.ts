// src/adapters/dsh/remote-contract.ts — 宿主发现 (Typert marker) 的契约守卫。
//
// 为什么需要 (2026-09-14 实测): @Remote 的标记**只写在插件自己加载的那份
// @deepseek-ai/dsh-typert-protocol 里**, 而"有哪些端点"是宿主 (dsh-api-gateway) 用它自己那份
// 去读的。两份实例不等价时, 插件的 19 个 @Remote 一个都不可见:
//
//   - protocol 0.1.1-rc.2 把标记存进**模块私有 WeakMap** —— 另一份实例读不到, 结果是
//     `remoteMethods(gateway)` 返回 `[]`。宿主据此判定 claimsEndpoint=false, 于是
//     /api/<namespace>/<method> 对**所有**方法一起回 404 not found;
//   - protocol >= 0.1.2-rc.1 改成原型上的字符串键属性
//     `"@deepseek-ai/dsh-typert-protocol/remote-methods"` —— 跨实例可读。
//
// 更糟的是故障形态: fiber 仍显示 active、插件组合正常、日志干净 —— 只有面板静默报错
// ("状态读取失败: transport failure ... HTTP 404")。单测也测不到: 直接调方法绕过了发现环节。
//
// 因此这里做两件事:
//   1. 让"宿主读到的端点集"成为**可导入的运行时能力** (`remoteMethodNames`), 测试与冒烟共用;
//   2. `assertRemoteContract` 在插件装配时把关 —— 这是"在更早、更清楚的地方失败"的落点,
//      而不是让 19 个端点一起变成 404。
//
// 下面刻意不 import 任何 @deepseek-ai 包: marker 的键是协议公开面的一部分 (字符串字面量, 跨版本不变),
// 用字面量读原型的属性描述符, 于是判定结果与"本模块加载了哪一份 protocol"无关 ——
// 任何一份依赖都改不动这个判定。
import { createRequire } from "node:module";

/** marker 在原型上的属性键 (dsh-typert-protocol >= 0.1.2-rc.1 起使用)。 */
export const REMOTE_METHOD_DESCRIPTOR_KEY = "@deepseek-ai/dsh-typert-protocol/remote-methods";

export interface RemoteMarker {
  method: string;
  exportName?: string;
  mode?: string;
}

interface RemoteMethodDescriptor {
  version: number;
  methods: RemoteMarker[];
}

/** 读一个实例所属原型上的 marker 表; 没有 (旧协议/非 Service/非 Typert) 时返回 undefined。 */
export function remoteMethodDescriptor(instance: object): RemoteMethodDescriptor | undefined {
  const holder: unknown = Object.getPrototypeOf(instance);
  if (holder === null || holder === undefined) return undefined;
  const property = Object.getOwnPropertyDescriptor(holder, REMOTE_METHOD_DESCRIPTOR_KEY);
  if (property === undefined) return undefined;
  const value: unknown = property.value;
  if (typeof value !== "object" || value === null) return undefined;
  const version: unknown = Reflect.get(value, "version");
  const methods: unknown = Reflect.get(value, "methods");
  if (version !== 1 || !Array.isArray(methods)) return undefined;
  // 深拷贝: 调用方不该拿到协议内部冻结的 marker 本身。
  return { version, methods: methods.map((m) => ({ ...(m as RemoteMarker) })) };
}

/** 实例上的 Remote 方法名 (按声明顺序)。宿主能发现的就是这个集合。 */
export function remoteMethodNames(instance: object): string[] {
  return (remoteMethodDescriptor(instance)?.methods ?? []).map((marker) => marker.method);
}

export interface RemoteContract {
  /** 插件声明要暴露的全部方法名。 */
  declared: readonly string[];
  /** 宿主**实际**能从该 Service 实例发现的方法名。 */
  discovered: readonly string[];
}

export function remoteContract(instance: object, declared: readonly string[]): RemoteContract {
  return { declared: [...declared], discovered: remoteMethodNames(instance) };
}

function diff(left: readonly string[], right: readonly string[]): string[] {
  return left.filter((name) => !right.includes(name));
}

/** 本模块同类实例加载到的 protocol 版本 (仅用于错误信息里给出可执行的线索)。 */
function loadedProtocolVersion(): string | undefined {
  try {
    const loaded: unknown = createRequire(import.meta.url)(
      "@deepseek-ai/dsh-typert-protocol/package.json",
    );
    const version: unknown = Reflect.get(loaded as object, "version");
    return typeof version === "string" ? version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 装配期把关: 宿主发现的方法集必须与插件声明的一致, 否则抛错。
 *
 * 为什么是抛错而不是打个 warning: 不匹配时全部端点 404, 而插件表面一切正常 ——
 * 这是"最坏的可观测性"。宁可让插件组装载失败 (profile 里立刻能看出), 也不要半死。
 */
export function assertRemoteContract(contract: RemoteContract): void {
  const missing = diff(contract.declared, contract.discovered);
  const extra = diff(contract.discovered, contract.declared);
  if (missing.length === 0 && extra.length === 0) return;
  const detail: string[] = [];
  if (missing.length > 0) {
    detail.push(
      `宿主看不到 ${missing.length}/${contract.declared.length} 个 Remote 方法: ${missing.join(", ")}`,
    );
  }
  if (extra.length > 0) detail.push(`宿主看到了未声明的方法: ${extra.join(", ")}`);
  // 最常见的成因是插件与宿主各加载了一份协议, 且那份协议的 marker 跨实例不可见。
  detail.push(
    "常见成因: 插件加载的 @deepseek-ai/dsh-typert-protocol (当前 " +
      `${loadedProtocolVersion() ?? "未知"}` +
      ") 与宿主 dsh-api-gateway 用的不是同一个实例, " +
      "且其 marker 机制跨实例不可见 (0.1.1-rc.2 用模块私有 WeakMap)。" +
      "请把它对齐宿主版本; 排查与修法见 .agents/notes/implemented/bug-fix/" +
      "2026-09-14-typert-remote-404-cross-instance.md。",
  );
  throw new Error("hx-memory: Remote 契约不自洽 — " + detail.join("; "));
}
