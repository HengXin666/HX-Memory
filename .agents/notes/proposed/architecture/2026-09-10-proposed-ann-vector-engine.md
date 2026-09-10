# Agent Note: 用 ANN 引擎替换内存线性向量索引

Status: proposed

## Problem

当前的向量索引是内存线性扫描 (`LinearVectorIndex`): 万级条目下检索 13.7ms/次, 但复杂度是 O(N·dim), 且没有持久化 —— 每次进程启动都要重新嵌入全部条目 (10k 条约 4 秒的冷启动, 见 `scripts/bench-retrieval.ts` 的 `cold_first_query_ms`)。条目规模再上一个数量级, 或要求启动即热时, 这条路走到头。

## Proposal

实现 `VectorIndex` 端口的第二个实现, 换掉线性扫描:

- 候选引擎 (按优先级): **sqlite-vec** (与真相同库、单文件、`loadExtension` 即可, MIT/Apache) → **LanceDB** (列式 + 多模态, Apache) → **Qdrant** (需要常驻服务, 仅多用户形态)。
- 保留现有契约: 身份 (`embedderId`/`dim`) 进索引, 不符即重建; 余弦下限仍由嵌入器声明; 投影 (异步嵌入器) 语义不变。
- 新增持久化: 索引落盘后, 冷启动不再需要全量重嵌; 但**真相仍在文件**, 索引永远可从真相重建。

## Alternatives considered

**继续用线性扫描, 靠加内存硬扛。** 万级可行, 十万级开始吃紧; 且冷启动成本随规模线性增长, 无法回避。

**在 SQLite 里手写量化向量 (int8 + 分桶)。** 零新依赖, 但等于自己造一个 ANN 索引 —— 与"不重复造市面轮子"的取舍冲突, 且正确性风险高。

**直接上向量数据库服务 (Qdrant/Milvus)。** 违背本地轻量化的既定目标 (用户明确要求本地、万级 1 秒内), 属于过度工程。

## Acceptance criteria

- 新引擎通过 `tests/conformance/retrieval-suite.ts` 全部契约, 且 `tests/s1/vector-index.test.ts` 的等价用例通过。
- `scripts/bench-retrieval.ts 100000` 的检索延迟 ≤ 50ms, 冷启动不再全量重嵌。
- 关掉该引擎时能自动退回线性实现, 结果里带可观测的降级说明。
- 索引身份与重建路径有测试钉住 (换模型 → 拒绝复用 → 全量重嵌)。

## Risks

sqlite-vec 仍是 0.1.x alpha (选项保留但需评估); 引入原生扩展会破坏"零依赖内核"的分布形态 (需隔离在 `src/storage/` 与可选依赖里); 持久化索引带来"索引与真相漂移"的新失效模式 (由 `verify()` 与 conformance 覆盖)。
