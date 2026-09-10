# Agent Note: 四层切面 (Surface / Application / Ports / Engines)

Status: implemented

## Problem

v1 只切了"宿主 vs 存储"两条线, 于是业务逻辑散在 `src/adapters/dsh/*`: DSH 的工具直接调 `FileBackend.query`, Codex 又各自实现一遍召回。结果是换宿主、换检索引擎、换抽取器这三类变化都要动记忆本体 —— 而这三类恰恰是**必然会变**的。

## Decision

按"变化频率"切成四层, 依赖方向单向 `L3 → L2 → L1 ← L0`:

- **L3 使用层** (`src/app/facade.ts` 的 `MemoryFacade`): 唯一对外 API; 宿主只能调它, 不能 import 引擎。DSH 的工具、pre-step 注入、面板 RPC, 以及 MCP 服务与 CLI 全部走它。
- **L2 应用层** (`src/capture`、`src/recall`、`src/evolution`、`src/generalize`、`src/app/{rebuild,consolidate,stack}.ts`): 记忆怎么被加工, 纯逻辑, 无宿主依赖。
- **L1 端口层** (`src/kernel/ports.ts`): 一切会被替换的东西都在这里声明 —— `MemoryStore`、`RetrievalSource`、`Retriever`、`Rebuildable`、`EpisodeStore`、`Embedder`/`SyncEmbedder`、`VectorIndex`、`IndexableSource`。
- **L0 引擎层**: 具体实现 —— `FileBackend` (Markdown 真相 + SQLite 派生 + FTS5)、`MemoryBackend` (纯内存第二实现)、`HybridRetriever`、`LinearVectorIndex`/`ProjectedVectorIndex`、三种 `Embedder`。

## Alternatives considered

**继续按"宿主 adapter"分目录。** 每个宿主一个目录看起来直观, 但它把"同一套语义"复制到 N 份 (治理闸门、去重、预算各写一遍), 且新增宿主必须理解全部内部; 现在新增宿主只需调 Facade。

**只做端口不做 Facade (让宿主直接组合服务)。** 端口解决了"换引擎", 没解决"换宿主": 每个宿主仍要自己决定先调谁、怎么拼注入文本。Facade 把用例编排收敛成一处。

**引入一个 DI 容器/框架来装配。** 与"零依赖内核"的取舍冲突, 且装配顺序 (真相→索引→检索→Facade→重建→整合) 是业务知识, 放进容器只是把它藏起来。现在集中在 `src/app/stack.ts` 一个函数里。

## Consequences

新增宿主 = 写一个 Surface (≤200 行) + 跑宿主契约测试, 内核与存储零改动; 代价是多一层间接 —— 小改动也要先想清楚它属于哪一层, 且 `scripts/verify.sh` 的类型闸门会拦住跨层 import。

## Testing

`tests/conformance/backend-contract.test.ts` 与 `retrieval-contract.test.ts` 用同一份契约跑不同实现; `tests/s2/mcp-surface.test.ts` 用真子进程验证"换宿主不换语义"。
