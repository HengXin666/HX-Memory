# storage/ — 存储层 (真相 ↔ 索引)

> 目的: 说明 `src/storage/` 下各文件的职责边界、写入语义与不变量 —— 这些是"改一行就会静默丢数据"的地方。
> 边界 (不写什么): 不写检索/排序策略 (在 `src/retrieval/`); 不写上层编排 (在 `src/app/`); 不写使用教程 (在 README)。
> 与代码的关系: 本目录只做"真相 ↔ 索引"的读写; 端口在 `src/kernel/ports.ts`, 上层只依赖端口。

## 布局

| 路径 | 是什么 |
| --- | --- |
| `<root>/daily/YYYY-MM-DD.md` | 每日捕获 (原始, 人可读, git 可 diff) |
| `<root>/digest/YYYY-MM-DD.md` | 整理后知识 (lesson/pattern/context) |
| `<root>/rules/<id>.md` | 推广后的跨项目规则 (人工确认后才落盘, 一文件一条) |
| `<root>/index.sqlite` | 派生索引 (memories/relations/tags 三表), 删除可重建 |

## 各文件职责 (为什么拆)

**拆分动机是"改一处不必通读全部"**: 想改"什么算合法"不必通读 SQL, 想改 SQL 不必担心碰坏解析。
单文件行数闸门 (`scripts/verify-structure.ts`, 上限 400 行) 是机械约束, 但不是理由本身。

| 文件 | 职责 |
| --- | --- |
| `file-store.ts` | 真相 ↔ 索引的**编排**与 SQL |
| `entry-normalize.ts` | 什么算合法的一条记忆 (写入与重建共用, 只有一处) |
| `markdown-codec.ts` | Markdown 的编解码 (转义 / 前言保留 / O(1) 追加) |
| `markdown-parse.ts` | 从**可被外部编辑的**文件里安全解析 (fail-closed) |
| `frontmatter.ts` | frontmatter 的键级工具 (解析与写回共用的单一事实源) |
| `fts-index.ts` | 全文检索索引 (中文 词 + bigram 双列) |
| `index-schema.ts` | 建表与补列 (幂等 DDL + check-then-ALTER) |
| `index-reader.ts` / `index-writer.ts` | 索引读写两侧 |
| `truth-scan.ts` | 真相目录扫描 (数块 / 判断有没有文件) |
| `episode-store.ts` | Episode 追加日志 (原文, 支撑换抽取器后重放) |
| `memory-store.ts` | 内存实现 (测试与 conformance 对照用) |

## 不变量 (改动前先读这一节)

1. **真相在文件, 索引可重建且无损**: relations/tags/structured 全部写进文件并可读回。
2. **双时态** `validAt`/`assertedAt` 每条必带, 且必须是 ISO 时间戳 (防换行注入伪造字段)。
3. **`kind:"rule"` 必须带确认记录**才允许入库 —— `add()` 与 `rebuildFromFiles()` 同一套闸门。
4. **正文不能伪造块边界** (写入转义); 所有 frontmatter 值都不能含换行。
5. **撤回 (`remove`) 在真相文件里写 `status: shadow`** —— 只改索引的话, 重建会让它复活。
6. **并发打开同一个 index.sqlite 不能直接炸**: 打开后立刻设 `busy_timeout`。
7. **陌生 frontmatter 键必须原样保留** (见下): 写回是整块重组, 不搬运就会静默丢字段。

## 写入语义: 陌生键保留 (无损的前提)

`upsertBlockInFile` 是"替换一个块"的唯一路径 (更新 / 迁移 / 整理都走它)。
替换时会先把**旧块里当前代码不认识的 frontmatter 键**搬运到新块 —— 键级工具在 `frontmatter.ts`。

为什么必须这样: 文件可能由**更新版本**写过 (降级运行) 或被**人手工编辑**。
此前写回是"整块重组 + 解析忽略陌生键", 于是更新一条记忆就会把它身上所有陌生字段静默吃掉 ——
任何迁移/整理在那之前都是破坏性的, 不是"无损"。位置会变 (附在末尾), 但键级 frontmatter 没有顺序语义。

## 并发

同一 id 并发写会出现两个块; 多进程共享同一 root 时, 读以**第一个**匹配块为准。
索引可 `rebuildFromFiles()` 重建, 因此这类残留是"可收敛"的, 不是永久损坏。
