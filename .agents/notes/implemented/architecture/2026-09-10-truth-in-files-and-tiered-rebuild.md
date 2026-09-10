# Agent Note: 真相在文件 + 分级重建 (T1/T2) + 索引身份

Status: implemented

## Problem

"记忆只存在某个检索引擎里"会让迁移变成考古: 换引擎要写数据搬迁脚本, 引擎损坏就丢历史, 而**抽取器升级时更糟** —— 只存抽取结果的话, 升级时只能对已经损失过一次信息的结果再抽一遍, 原文永远回不来了。同时, 派生索引一旦与真相漂移, 检索会静默返回错误结果而不报错。

## Decision

- **真相在文件**: Markdown 是事实源 (人可读、git 可 diff), SQLite/FTS5/向量都是**派生**, 删除可重建。演化字段 (entities/importance/reinforcement/lastHitAt/expiresAt/derivedFrom/mergedFrom) 与关系全部写进 frontmatter 并可读回, 往返无损。
- **原文也是真相**: `episodes/YYYY-MM-DD.jsonl` 追加日志保存轮次原文 (可开关 + 保留期), 记忆条目用 `derivedFrom` 指向它。
- **分级重建**:
  - **T1** `rebuildFromTruth()`: 真相文件 → 结构化 + 全文索引 (幂等)。
  - **T2** `RebuildService.rebuildFromEpisodes()`: 原文 → 记忆 (换抽取器时**重放**而不是重聊)。同一抽取器重放幂等; 换了抽取器则新结果落盘、旧结果置 `superseded` (不删除, 历史可查)。
- **索引身份**: 派生索引带 `schemaVersion` (格式 + 分词版本) 与 `embedderId`/`dim`; 不符即重建, 不许混用两种索引 (混用 = 静默失真)。
- **一致性自检**: `verify()` 对比真相条目数与索引行数、全文行数, 不一致就报出 drift 而不是假装通过。

## Alternatives considered

**全存 SQLite (文件只做导出)。** 检索最快, 但失去了"可读、可 git diff、可手编"的属性, 且真相被锁进一个二进制文件; 我们的记忆量级 (万级) 不需要这个交换。

**只存抽取结果 (不做原文日志)。** 最省空间。但实测这是**不可逆**的: 一旦换了抽取器, 老数据只能重抽已有记忆 —— 信息已经损失过一次。原文日志的代价是磁盘与隐私责任, 用"可开关 + 保留期"来控制。

**索引里存全部语义, 重建尽力而为。** 曾经这样做过, 结果是重建丢 relations、二次写入把旧正文留在文件里 (真相文件被写坏)。改为"文件里存全部语义, 重建必须无损"后由测试钉住。

## Consequences

真相文件更长、写入路径多一步索引维护; 换来"删库不丢真相""换引擎是接线而不是改造"。代价还有: 原文日志需要保留期与关闭开关 (隐私), 且 T2 重放需要抽取器可重复执行 (已用内容指纹 id 保证)。

## Testing

`tests/s2/evolution-fields.test.ts` (往返无损)、`tests/s2/episode-store.test.ts`、`tests/s2/rebuild.test.ts` (幂等 + 取代不删除 + 失败不中断)、`tests/s2/file-store-integrity.test.ts` 与 `file-store-hardening.test.ts` (防伪造块/前缀保留/撤回持久)。
