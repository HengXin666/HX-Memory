// src/adapters/dsh/gateway-mount.ts — 面板网关的**装配** (从 index.ts 抽出, §795)。
//
// 为什么独立成文件: 组装根 `index.ts` 触及 400 行上限 —— 而那一块 (网关依赖填装 + 远端契约校验)
// 是**一个完整职责**: "把面板要用的服务装成 HxMemoryGateway, 并在装配期校验远端契约"。
// 它与组装根其余部分 (设置接线 / 工具注册 / 定时器) 的变化原因不同 —— 前者随**面板新增出口**变,
// 后者随**宿主生命周期/设置**变。行数上限在这里又一次起到了它该起的作用。
//
// 契约校验为什么必须在装配期: 宿主是**用它自己那份** dsh-typert-protocol 读 `@Remote` 标记的,
// 两份实例不等价时**全部端点会静默 404**, 而 fiber 依旧 active。在装配期失败比让面板收到一堆
// 404 强 —— 加载错误能一眼看见, 静默 404 不能。
import type { Context } from "@deepseek-ai/cordis";
import { HxMemoryGateway, type HxMemoryGatewayDeps } from "./gateway.ts";
import { HXMEM_REMOTE_METHODS } from "./remote-methods.ts";
import { assertRemoteContract, remoteContract } from "./remote-contract.ts";

/** 装配网关所需的一切 (组装根负责算, 本模块负责装)。 */
export interface GatewayMountInput {
  ctx: Context;
  /** 面板要用到的全部服务面 —— 与 `HxMemoryGatewayDeps` 同源, 少一项就少一个出口。 */
  deps: Omit<HxMemoryGatewayDeps, "truthFiles">;
  /** memory root —— 真相文件视图要用它列举/读取 (只读)。 */
  root: string;
}

/**
 * 挂载 Review Web 服务 (Typert Remote): Service 构造即注册, 随 fiber 自动卸载。
 *
 * `bindingStore` 必须**无条件注入** —— 否则面板 `saveBindings` 永远返回
 * "binding store not mounted"。`maintenance` 同理 (漏注入的表现是面板上没有维护区块,
 * 而那正是本功能要消灭的那类"不可见")。
 */
export function mountGateway(input: GatewayMountInput): void {
  input.ctx.effect(() => {
    const gateway = new HxMemoryGateway(input.ctx, {
      ...input.deps,
      // 真相文件视图 (§795): 只读列举/读取 —— 让"真相在文件"在人侧也看得见。
      truthFiles: { root: input.root },
    });
    assertRemoteContract(remoteContract(gateway, HXMEM_REMOTE_METHODS));
    return () => void 0;
  }, "hx-memory.gateway()");
}
