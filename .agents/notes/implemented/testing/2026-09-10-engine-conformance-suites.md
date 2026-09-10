# Agent Note: 引擎准入 = conformance 契约套件 (存储侧 + 检索侧)

Status: implemented

## Problem

"存储/检索引擎可插拔, 将来轻松迁移"这句话如果没有统一验收, 每次迁移都会变成一次考古: 新引擎跑起来看着能用, 但撤回会不会复活、重建后关联还在不在、未确认的规则会不会被召回 —— 这些只有踩过才知道。而这些恰恰是**换引擎时最容易静默失效**的语义。

## Decision

把契约写成**参数化的测试套件**, 新引擎的实现者跑同一份:

- **存储侧** `tests/conformance/suite.ts` + `backend-contract.test.ts` (21 项): 端口形状、写入读取逐字段往返 (含演化字段)、治理铁律 (未确认 rule 拒绝)、条件语义 (kind/scope/project/tag/at/limit)、关系遍历可见性、撤回是持久 shadow、`all()` 不被默认 limit 截断、重建幂等 + verify 全绿、重建不复活撤回、重开后数据仍在。已覆盖 `FileBackend` 与 `MemoryBackend`。
- **检索侧** `tests/conformance/retrieval-suite.ts` + `retrieval-contract.test.ts` (29 项): 黄金集召回、无关查询不返回、确定性 (同请求同顺序)、规则保底与未确认拦截、预算硬约束、演化链只注入最新版、可见性、图扩展的可审计 `why`、能力自述与降级一致、向量通道召回。三种引擎组合 (FileBackend+向量 / MemoryBackend+向量 / FileBackend 无向量) 跑同一份。

**没有过 conformance 的实现不许进 `src/storage/`。**

## Alternatives considered

**为每个引擎写各自的测试。** 便宜, 但会漏掉"另一个引擎被测过、这个没有"的语义; 而且新引擎的验收标准会随作者变化 —— 这正是契约要消除的不确定性。

**只写集成测试 (端到端从宿主跑)。** 能证明"能跑", 但定位不到具体是谁违反了哪条契约; 且宿主测试成本高, 不会有人为新引擎补。

**用文档写验收清单, 人工核对。** 文档会被忽略。conformance 的价值就在于它是**可执行**的: 加一行 `describeBackend` 就自动获得全部契约。

## Consequences

引擎的进入门槛变高 (这是故意的): 实现者必须让 21+29 项通过; 换来迁移是"接线"而不是"改造", 且每条契约失效时都会指到具体文件名与语义。代价是套件本身要随语义演进维护 (新增契约要同时改两个实现)。

## Testing

套件自身即测试; `tests/s1/ports.test.ts` 另有类型级断言, 防止端口退化成装饰性文档。
