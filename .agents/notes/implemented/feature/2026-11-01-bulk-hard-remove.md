# Agent Note: 批量物理删除与知识库清库

Status: implemented

Decision-ID: bulk-hard-remove

## Code

- `src/storage/bulk-remove.ts`
- `scripts/kb-purge.ts`

## Problem

用户选择清掉知识库, 只留对话沉淀: 记忆根 4672 条 `kind: doc` (source `kb:`), 1373 条对话沉淀不能动。

index.sqlite 是派生索引, 真相在 daily/*.md。只删 sqlite 的行, 任何一次 `rebuildFromFiles()` 都会让 4672 条复活。仓库已有的物理删除入口是 `FileBackend({ allowTruthDelete: true }).remove()`, 但 4058 条在同一个 7.7MB 文件里, 逐条调用要整读整写该文件 4058 遍。

## Decision

`removeMany(ids)` 用与单条 `remove()` 同一判据 (块以 `---\nid: <id>\n` 开头), 按真相文件分组, 每个文件只读写一次; 先改真相, 再在一个事务里删索引行 (memories / tags / entities / relations.from / FTS)。非 hard 模式退化为逐条 shadow。

`scripts/kb-purge.ts` 按「一致性快照备份并核对行数 → 只选 source kb: 且 kind doc → removeMany → 六条校验 (含从真相重建后 doc 仍为 0) → 清空 panel.json 的知识库来源 → 报告」执行, 不加 `--apply` 只备份不删。

## Alternatives considered

**什么都不做 / 复用现有逐条 remove。** 最强理由: 零新代码, 判据天然一致。否决: 15GB 量级的重复 IO, 且中途中断会留下一半删除的真相文件。

**裸 SQL 删索引行。** 重建即复活, 违反「真相在文件」不变量。

**写 shadow 而不是删块。** 4672 个 shadow 块留在 daily 文件里, 表的行数回不到 1373, 也不是用户要的「清掉」。

## Consequences

**换来的**: 清库在真库拷贝上 24 秒完成, 1373 条对话沉淀的真相块逐字节不变, 重建不复活。

**付出的**: 物理删除不可从记忆根内部复原, 只能用备份目录回滚 (报告里写了步骤)。

## Testing

- `tests/s2/bulk-remove.test.ts`: hard 模式与逐条 remove 的真相文件逐字节一致、verify 通过、删索引后从真相重开不复活; 非 hard 模式写 shadow。
