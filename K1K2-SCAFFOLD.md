# K1K2-SCAFFOLD — K1/K2 120 条人写题脚手架

## 1 结论

**就绪, 人现在就能开始填。** `draft.jsonl` 120 行, gold 文件与标题机械校验全部通过, `question` 全空 (已填 0 条, 未填 120 条); 判分脚本在调用方机器上真实跑过全空 / 预填 3 条 / 清空三种状态 (外加一次全填路径冒烟), 输出见第 4 节。

## 2 现状四问 (调用方机器上 grep -n 核对过行号)

**2.1 kb-retrieval.ts 期待的数据结构**
- 文件: `tests/fixtures/eval/kb-queries.jsonl`, **jsonl**, 一行一条; 可用 `--queries` 覆盖 (scripts/eval/kb-retrieval.ts:29)。
- 字段: `KbQuery { qid, kind: "title"|"detail"|"cross", dir, expect_paths: string[], section?, question, author }` (kb-retrieval.ts:32-40)。
- 该文件已存在 120 个槽位 (`--make-slots` 按 fnv1a 确定性分层抽样写出, 52-113 行): title/detail/cross 各 40, dir 分布 docs 108 / blog 6 / ai-docs 6; detail 类都带 `section`。question/author 全空。
- 判分口径: KbSync 同步 `--src` 到临时 memory (125-128), `retrieveSync({text: question, purpose:"recall", kinds:["doc"], limit:10})` (130), 路径 = source 去掉 `kb:` (131); rank = 前 10 首个落在 expect_paths 的名次; hit5 = rank 1..5; rr = 1/rank 或 0 (132-134); 小节级命中 = 前 5 条有期望文件切片且内容含 `"/ " + section` (133); K1 = hit5 比例, K2 = 平均 rr (136-137); 阈值 K1 ≥ 0.8, K2 ≥ 0.6 (143-144)。

**2.2 gold 一侧**
- 博客根: `/home/hx/Loli/code/HXLoLis/HXLoLi` (scripts/eval/kb-coverage.ts:7 的用法示例)。
- `DEFAULT_KB_DIRS = ["blog", "ai-docs", "docs"]` (src/kb/kb-sync.ts:118); `walkMarkdown` 只走这三个目录, 跳过隐藏项与 node_modules, 只收 `.md` (120-144)。kb-retrieval.ts 用它做抽样语料 (57) 与 KbSync 默认 dirs。
- 切片: `sliceMarkdown` 按 `## ` 切, 每片 heading = `##` 文本或文章标题 (front matter `title`, 否则文件名), body 以 `# 标题 / 小节` 开头 (kb-sync.ts:32-56) —— 这就是 detail 类小节命中靠 `"/ " + section` 判定的原因。切片不落盘, 每次评测临时同步。
- 命名空间: `kbNamespace(root)` = `"r" + sha256(root)[0:10]` (106-108); 写入时 source = `"kb:" + (ns ? "@"+ns+"/" : "") + rel` (245); `kbSourceNamespace` 把 `kb:@ns/file` 解析成 `{ns, file}`, 主语料 ns = "" (111-116)。评测只用主语料 (不传 namespace), 所以 source 恒为 `kb:<相对路径>`, kb-retrieval.ts 直接 `replace(/^kb:/,"")` 即可; 在 src/ 中 `kbSourceNamespace` 除定义外没有其他调用方。

**2.3「question 为空」在哪判**
- scripts/eval/kb-retrieval.ts:118 `const empty = qs.filter((x) => !x.question?.trim());` —— 条件是 question 缺失或 trim 后为空。
- 119-123: 只要 `empty.length > 0` 就打印「查询集 N 条, 其中 M 条 question 为空; EVAL 2.2 要求人写问题, 拒绝打分」、前 3 个空槽位、「K1/K2 = 未测」, 返回退出码 2。是全有或全无, 没有部分打分。

**2.4 tests/fixtures/eval/ 的组织方式**
- 每个评测集一个 jsonl (一行一条, 字段平铺) 或一个子目录 (`frustration/` 下 samples / candidates-v2 / next-assistant / regression 四个 jsonl), 生成与打分脚本放 `scripts/eval/`。
- `tests/fixtures/eval/README.md` 为每个集合写一节: 版本 / 构建日期 / 规模 / 标注人表格、抽样方法、字段、标注规则、Not done。
- 照此风格: 新建 `k1k2/` 子目录放 jsonl 与说明, 打分脚本放 `scripts/eval/k1k2-score.ts`, 并在 README.md 末尾追加了 `## k1k2/draft.jsonl` 一节 (同样的表格结构)。没有另立格式: draft 的每一行就是 kb-queries.jsonl 同 qid 槽位的展开。

## 3 交付物

| 路径 | 形态 |
|---|---|
| `tests/fixtures/eval/k1k2/draft.jsonl` | 120 行 jsonl; 字段 `id, kind, dir, gold_path, gold_paths[], gold_heading, heading_level, question, why, difficulty, author, source`; 人只填 question / why (author 可选) |
| `tests/fixtures/eval/k1k2/template.jsonl` | 1 行, 每个字段写明谁填、填什么 |
| `tests/fixtures/eval/k1k2/WRITING-GUIDE.md` | 好题标准 / 6 组泄题 vs 不泄题并排反例 (全用与博客无关的虚构文章, 避免变成代写) / 难度三档 / why 写法 / 30 秒一条, 60 秒上限 |
| `.hark-tmp/k1k2/make-draft.py` (不进版本, .gitignore:34) | 从 kb-queries.jsonl 的 120 槽位生成 draft; 标题取自真实文件 |
| `.hark-tmp/k1k2/verify-gold.py` (不进版本) | 一次性机械校验 (独立于 TS 实现) |
| `.hark-tmp/k1k2/fill3.py` (不进版本) | 试跑用: 预填 / 清空 k001 k041 k081 |
| `scripts/eval/k1k2-score.ts` | 判分; `--check` 校验, 默认跳过空题打分, `--export` 全填后写回 kb-queries.jsonl |

draft 生成规则: `id` = 槽位 qid; `gold_paths` = expect_paths (cross 类 2 篇), `gold_path` = 第一篇; `gold_heading`: detail 类 = 槽位 section (`##`), 其余 = front matter `title` (8 条), 没有就取第一个 `# ` (72 条)。关于那 8 条: 博客是 Docusaurus, front matter `title` 就是页面渲染出的一级标题 (H1); 其中 k002 正文里没有任何 `#` / `##`, front matter title 是它唯一的标题, 其余 7 条为了与 title 类口径一致也取文章标题而不是第一个 `##`。gold_path 均为**相对博客根** `/home/hx/Loli/code/HXLoLis/HXLoLi` 的路径, 与 kb-retrieval.ts 的 expect_paths 同一口径 (EVAL.md:69), 不是相对 HX-Memory 仓库; `difficulty` 按类预填 title=1 / detail=2 / cross=3, 人可改; `source` = `kb-queries.jsonl#qid`。

命令 (仓库根):
```
python3 .hark-tmp/k1k2/make-draft.py /home/hx/Loli/code/HXLoLis/HXLoLi tests/fixtures/eval/kb-queries.jsonl tests/fixtures/eval/k1k2/draft.jsonl
python3 .hark-tmp/k1k2/verify-gold.py /home/hx/Loli/code/HXLoLis/HXLoLi tests/fixtures/eval/k1k2/draft.jsonl
node --experimental-strip-types --no-warnings scripts/eval/k1k2-score.ts --src /home/hx/Loli/code/HXLoLis/HXLoLi --check
node --experimental-strip-types --no-warnings scripts/eval/k1k2-score.ts --src /home/hx/Loli/code/HXLoLis/HXLoLi
node --experimental-strip-types --no-warnings scripts/eval/k1k2-score.ts --src /home/hx/Loli/code/HXLoLis/HXLoLi --export   # 120 条全填后
```

k1k2-score.ts 的口径与 kb-retrieval.ts 逐行一致 (第 2.1 节所列行), 阈值 0.8 / 0.6 原样; 区别只有: 跳过空题; 未填 > 0 时打印「部分结果, n=已填数」并返回 2; 部分结果不写 eval-out/K1.json、K2.json, 不调 writeReport, 正式数仍由 kb-retrieval.ts 出。

## 4 真实试跑 (exec 通道, 调用方机器, node v26.12.0)

校验脚本 `.hark-tmp/k1k2/verify-gold.py` 输出原样 (22:1x 重跑):
```
draft 行数 120; kind {'title': 40, 'detail': 40, 'cross': 40}; 标题层级 {'title': 8, 'h1': 72, 'h2': 40}; 校验文件 160 个 (含 cross 搭档)
question 为空 120/120; why 为空 120/120
结果: 全部通过
exit=0
```

**机械校验** (生成后):
```
$ python3 .hark-tmp/k1k2/make-draft.py ...
120 rows; bad: []
$ wc -l tests/fixtures/eval/k1k2/draft.jsonl
120 tests/fixtures/eval/k1k2/draft.jsonl
$ python3 .hark-tmp/k1k2/verify-gold.py /home/hx/Loli/code/HXLoLis/HXLoLi tests/fixtures/eval/k1k2/draft.jsonl
draft 行数 120; kind {'title': 40, 'detail': 40, 'cross': 40}; 标题层级 {'title': 8, 'h1': 72, 'h2': 40}; 校验文件 160 个 (含 cross 搭档)
question 为空 120/120; why 为空 120/120
结果: 全部通过
$ node ... k1k2-score.ts --src ... --check
draft 120 行; 机械校验 通过 (gold_path 全部存在, gold_heading 全部是真实标题)
exit=0
```

**三次试跑** (2026-11-03 22:1x CST, 一次 exec 内连续执行; md5 = draft.jsonl 的 md5, 填前与清空后相同, 证明 3 条试填已逐字节清回):
```
md5 4f4b8f9692fc1f5aec22b91ece2b6617
===== RUN1 全空
draft 120 条: 已填 0 条, 未填 120 条
已填 0 条, n=0; K1/K2 = 未测 (没有可打分的题)
exit=2
fill filled: 3
===== RUN2 预填 3 条
draft 120 条: 已填 3 条, 未填 117 条
  k001 title  rank=1  top1=blog/2025/05/07/001-小灶分享.md
  k041 detail rank=1 §✗  top1=blog/2025/05/09/01-项目演示小灶.md
  k081 cross  rank=3  top1=ai-docs/003-AI/004-记忆/002-自维护可插拔记忆层设计/index.md
【部分结果 n=3 (已填 3 条, 未填 117 条); 不是正式 K1/K2, 不可与阈值比较】 K1 Hit@5=1.0000  K2 MRR@10=0.7778
分类: {"title":{"n":1,"hit5":1,"mrr":1},"detail":{"n":1,"hit5":1,"mrr":1},"cross":{"n":1,"hit5":1,"mrr":0.3333}}
分组: 自己的文章 (blog+ai-docs) {"n":3,"hit5":1,"mrr":0.7778}; 学习笔记 (docs) {"n":0,"hit5":null,"mrr":null}
小节级命中 (detail): 0/1
exit=2
clear filled: 0
md5 4f4b8f9692fc1f5aec22b91ece2b6617
===== RUN3 清回全空
draft 120 条: 已填 0 条, 未填 120 条
已填 0 条, n=0; K1/K2 = 未测 (没有可打分的题)
exit=2
```
对照原脚本 `kb-retrieval.ts --src ...` (全空时): 「查询集 120 条, 其中 120 条 question 为空; EVAL 2.2 要求人写问题, 拒绝打分 … K1/K2 = 未测」, exit=2 (未改动)。

**附: 全填路径冒烟** (只在 /tmp 临时副本上跑, 跑完已删; question = gold_heading 原文, 即故意泄题, 只为走通「未填 0」分支, 数字没有意义, 不是 K1/K2):
```
draft 120 条: 已填 120 条, 未填 0 条
(n=120, 全部已填) K1 Hit@5=0.8667  K2 MRR@10=0.7304
分类: {"title":{"n":40,"hit5":35,"mrr":0.7153},"detail":{"n":40,"hit5":29,"mrr":0.6604},"cross":{"n":40,"hit5":40,"mrr":0.8154}}
分组: 自己的文章 (blog+ai-docs) {"n":12,"hit5":1,"mrr":1}; 学习笔记 (docs) {"n":108,"hit5":0.8519,"mrr":0.7004}
小节级命中 (detail): 25/40
阈值: K1 >= 0.8 达标; K2 >= 0.6 达标 (正式数请 --export 后用 kb-retrieval.ts 出)
```
旁证: 连照抄标题都只有 0.87 / 0.73, 人写的换说法题只会更低, 现在的分数不说明检索达标。(冒烟那次的 exit 被管道里的 grep 吃掉了, 退出码没单独记; 代码路径是全填时 0 = 达标, 1 = 未达标。)

## 5 人接下来做什么

先读 WRITING-GUIDE.md (5 分钟), 再按 draft.jsonl 顺序每次 40 条, 只看 gold_heading 写 question 与 why, 写完随手跑 k1k2-score.ts 看部分结果 (别按分数改题), 120 条填满后 `--export`, 再跑 kb-retrieval.ts 出正式 K1/K2。

## 6 判据自查

| # | 判据 | 结果 |
|---|---|---|
| 1 | template.jsonl / draft.jsonl / k1k2-score.ts / WRITING-GUIDE.md 都存在 | ✓ (exec 写入并 ls 过) |
| 2 | draft.jsonl 恰好 120 行 | ✓ `wc -l` = 120 |
| 3 | draft.jsonl 每行 question 为空字符串 | ✓ verify-gold.py: question 为空 120/120, 3 条试填已清, md5 复原 |
| 4 | 本文件 > 3000 字节 | ✓ (见下方最终校验) |
| 5 | 出现 `n=` / `已填` 带数字 | ✓ 「已填 0 条」「n=3」「已填 3 条」 |
| 6 | WRITING-GUIDE.md 里「泄题」≥ 5 次 | ✓ 16 次 |

禁区: 120 条 question 一条没写 (3 条试填已清回空); kb-retrieval.ts 未改 (`git diff` 工作区无改动, 它的 `M` 状态是之前已暂存的改动, 不是这一轮); src/ 未碰; 未 git commit。另: 本轮途中 fs 映射读写 (GET/PUT) 从 21:51 起一直回 403「token 不对」, 文件全部改由 exec 通道写入; 新出现的 `tests/fixtures/eval/unbiased/` 不是本轮创建的, 未碰。
