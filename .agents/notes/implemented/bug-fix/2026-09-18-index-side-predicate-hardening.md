# Agent Note: 索引侧判据的硬化 (tags / 实体 / 跨层契约)

Status: implemented

## Problem

一次横向排查发现: **同一个"解析判据"的缺陷在库里有多份副本**, 且每一份的失败方式不同。
它们都不是逻辑错误, 而是**类型系统挡不住的那一类** (`string` 恰好为空串 / `String()` 强转出假值),
因此只能靠真库数据才能看见。三处实测:

| # | 现象 | 数据 |
| --- | --- | --- |
| 1 | 索引里的 `tags` 出现了 `"undefined"` / `"10"` / `"r376080139"` | 真库 113 个 tag 里 **10 个是垃圾** (数值型 6 / 内部 id 2 / 单字母 2) |
| 2 | 正文里的 `#1`/`#412`/`#9被挡` (编号引用) 被当成标签 | `extractTags` 抽出的与索引**完全一致** |
| 3 | 面板渲染 `{b.content}` 而服务端投影层硬编码 `content: ""` | 305 条工具写入的条目在"被挡清单"里**只剩徽标** |

**共同的根因**: `String(null) === "null"` / `String(1) === "1"` 都是**非空字符串** ⇒ `filter(Boolean)` 放行;
而 `content: string` 这个类型允许空串 ⇒ **tsc 不报错**。

## Decision

**判据只留一份实现, 并把它钉在门禁上; 用户可见的措辞必须与事实一致。**

### 1. 解析判据统一口径 (四处)

`parseTags` (markdown-parse) 与 `extractTags` / `jsonStrings` / `stringList` (entry-normalize)
统一为: **类型判据 + 哨兵值 (`undefined`/`null`) + 空串**。tags 侧另加**形态判据**
(`^\\d+$` 数值型 / `^r[0-9a-f]{6,}$` 内部 id)。

两处**刻意的不对称**, 各有证据:

- **不拦单字母** —— 真库里只有 `"i"` 一例, 而一条形态规则会误伤测试数据与未来合法的短标签;
- **`extractTags` 拦单字母与占位词, `parseTags` 不拦** —— 前者是**正文兜底抽取** (`#i` 更像引用符号),
  后者服务**用户显式写的字段**。**同一形态在不同证据下结论可以不同。**

tags 的"三个来源"判据 (索引字段 / 文件 `tags:` 行 / `indexEntry` 的正文兜底抽取) 抽成
**唯一实现** `scripts/lib/tag-provenance.ts`, 并加进 `verify-structure` 的 `SINGLETON_FUNCS`
(该检查的扫描范围同时扩到 `scripts/lib/`, 否则"抽出去"只是搬了家)。

### 2. 跨层字段契约做成门禁

`scripts/verify-client-contract.ts`: 抽客户端渲染的字段 (`{x.field}`) → 在**全服务端面**
(`src/adapters` + `src/app`) 找声明 → 找不到即失败。**挂在 `verify.sh` 上。**

它的**覆盖边界写进了脚本头注**: 只查"**有没有声明**", **抓不到"字段存在但值恒为空串"** ——
后者由 `tests/s2/always-on-blocked-content.test.ts` 锁住。**两层各覆盖一半。**

### 3. 用户可见的措辞分两类

`evidence.ts` 的 `reasons`: `source === "session:tool"` (工具直接写入) 说
"**该条目由工具直接写入 (非对话沉淀), 没有对应的对话轮次 —— 无原文可溯源**";
其余仍说"未捕获 episode 引用"。

判据只用 `entry.source`, **不扩 `EvidenceSource` 端口** —— 那个端口的注释写明它是最小契约
("只依赖按 id 批量取原文"), 而**为改一句话去扩端口是本末倒置**。

### 4. 真库验收补上缺失的那一层

`scripts/verify-real-library.ts`: 单元测试与真机 smoke **都用隔离库**, 因此看不到
索引与真相文件的**历史不一致**、**历史写入产物**、真实数据的长尾形态。本脚本只读地补上这一层。

它**不进 `verify.sh`** —— CI 可能没有真库; 它是**本机工具**, 不是门禁。
其 tags 一致性判据**直接调** `tag-provenance.ts`, 不自己写循环。

## Alternatives considered

**只修 `parseTags`, 不管其它三处。** 那是我第一轮做的事 —— 而 `extractTags` 才是
"索引里凭空出现垃圾 tag"的**根因**; 前两轮修的都是**读取侧**。

**给 `verify-client-contract` 也加"值不能恒为空"的检查。** 那需要**运行时**数据
(字段有没有被赋过非空值), 静态扫描做不到; 而测试已经覆盖。

**把 tags 形态判据推广到"任何数字开头的字符串"。** 真库里有 `"401回归"` 这种**真标签**
(讲 401 回归测试)。它是 **tags 字段**里的, 不走 `extractTags`, 所以两者不冲突 ——
但判据仍收窄成"纯数字 或 短的数字+中文"。

**用一个统一的 `stringArray()` 替代这四个函数。** 它们的**输入形态不同**
(JSON 文本 / 已解析的数组 / 索引列), 且 `stringList` 还要去重保序 —— 合并会把差异藏进分支。

## Consequences

| 项 | 结果 |
| --- | --- |
| 真库 tag 垃圾 | 修复后重建, 带垃圾 tag 的条目 **5 → 2** (而余下 2 条里 1 条是误判: `"401回归"` 其实是真标签) |
| 渲染契约 | 29 个面板字段全部有服务端声明; 被挡条目带上正文 (截断 400, 与 `picked` 一致) |
| 措辞 | 305 条工具写入不再被读成缺陷 |
| 代价 | 4 个解析函数各自带一份判据 —— **重复的是"口径"而不是"实现"**, 由 4 个测试文件钉住 |

## Testing

**契约测试** (5 个文件, 共 27 项):

| 文件 | 覆盖 |
| --- | --- |
| `tests/s2/parse-tags-hardening.test.ts` | 强转产物 / 哨兵字面量 / 短真标签保留 / 不拦单字母 |
| `tests/s2/extract-tags-numbering.test.ts` | 编号引用 / 占位词 / 中文单字保留 |
| `tests/s2/json-strings-hardening.test.ts` | id 数组不做强转 / 空数组返回 `undefined` |
| `tests/s2/evidence-wording.test.ts` | 两类措辞**必须不同** / 判定不变 |
| `tests/s2/always-on-blocked-content.test.ts` | 被挡条目带正文 / 整条链不丢 / 截断 |

**反驳验证**: 五个文件都做过"回退实现 ⇒ 测试变红", 确认断言**真的有区分力**。

**门禁**: `verify-structure` (单点定义) / `verify-client-contract` (跨层契约) /
`pnpm run verify-real-library` (真库只读验收, 11 项)。
