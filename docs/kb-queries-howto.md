# K1/K2 查询集填写说明 (博客检索 Hit@5 / MRR@10)

## 目的

`tests/fixtures/eval/kb-queries.jsonl` 里有 120 个槽位, 每个槽位已经确定了「应该命中哪篇文章」(以及 detail 类要命中的小节), 但 `question` 字段全部为空。
`scripts/eval/kb-retrieval.ts` 遇到任何一条空问题就拒绝打分 (退出码 2)。这份文档说明怎么由人把问题填上、怎么跑、看哪几个数。

## 边界

- 问题必须由人写, 不能用 LLM 从原文生成, 也不能由写检索代码的 agent 代写 (EVAL.md 2.2: 用原文词汇出题会把字面检索的分数抬高, 等于泄题)。
- 只填 `question` 和 `author` 两个字段; `qid` / `kind` / `dir` / `expect_paths` / `section` 是抽样结果, 不要改。想换期望文章, 用 `--make-slots --force` 重新抽样 (会清空已写的问题)。
- 知识库清空 (KB-PURGED.md) 不影响这项评测: 脚本每次在临时目录里从 `--src` 重新建索引, 不读 `~/.dsh/hx-memory`。

## 与代码的关系

- 槽位生成与打分: `scripts/eval/kb-retrieval.ts` (`--make-slots` 生成, 默认模式打分)。
- 索引与切片: `src/kb/kb-sync.ts` (与 K3 覆盖率脚本 `scripts/eval/kb-coverage.ts` 同一口径)。
- 检索: `src/app/stack.ts` 的混合检索器; 当前没有配置远端嵌入器, 向量通道是 LexicalEmbedder (词典 + 字级 n-gram), 也就是说 K1/K2 测的是**字面检索**, 不是语义检索。

## 一 怎么填

每行一个 JSON。以第 1 行为例, 现在是:

```
{"qid":"k001","kind":"title","dir":"blog","expect_paths":["blog/2025/05/07/001-小灶分享.md"],"question":"","author":""}
```

打开 `expect_paths` 指的文章读一遍, 写一句**你自己真会问的话**, 填进 `question`, `author` 写你的名字或缩写:

- `title` 类 (40 条): 问的是这篇文章的主题, 但**不要用标题里的词**。
- `detail` 类 (40 条): 答案在 `section` 指的那个 `##` 小节里, 问那个细节。
- `cross` 类 (40 条): `expect_paths` 有 2 篇或以上, 问一个需要这几篇一起回答的问题。

只要有一条 `question` 是空的, 脚本就不打分。可以分几次填完, 中途跑脚本只会看到退出码 2 和剩余空槽的数量。

## 二 填完怎么跑 (宿主 Node v26.12.0, 在仓库根执行)

```
node --experimental-strip-types --no-warnings scripts/eval/kb-retrieval.ts --src /home/hx/Loli/code/HXLoLis/HXLoLi --out eval-out
```

退出码: 0 = K1 >= 0.80 且 K2 >= 0.60; 1 = 测到但未达标; 2 = 还有空问题 / 参数错误; 3 = 运行出错。
产物在 `eval-out/` 下 (K1/K2 的 JSON), 评测页 `docs/eval-report.html` 同时重生成。

现在 (问题全空) 跑这条命令的输出是:

```
查询集 120 条, 其中 120 条 question 为空; EVAL 2.2 要求人写问题, 拒绝打分
空槽位前 3 个: k001(title) blog/2025/05/07/001-小灶分享.md; k002(title) blog/2025/06/30/01-调教VSCode.md; k003(title) ai-docs/003-AI/010-HX-AI-Review通用AI-CR方案/index.md
K1/K2 = 未测
```

## 三 看哪几个数

| 数 | 含义 | 门限 (EVAL.md, 未改) | 不达标先查什么 |
|---|---|---|---|
| K1 Hit@5 | 前 5 条结果里有没有期望文章 | >= 0.80 | 文章入库没有 (K3), 再看切片是否切断了答案 |
| K2 MRR@10 | 期望文章排第几 (1/名次, 10 名外记 0) | >= 0.60 | K1 达标而 K2 不达标时调打分和权重 |
| 分类 K1 (title / detail / cross) | 三类分开看 | — | title 类低说明问法换了词就搜不到 (字面检索的典型弱点) |
| detail 类的小节级命中 | 命中的切片是否就是 `section` 指的小节 | — | 切片粒度 |

title 类分数明显低于 detail 类, 就是「没有语义检索」的直接证据, 这时再考虑配置 `HX_MEMORY_EMBEDDING_BASE_URL` / `HX_MEMORY_EMBEDDING_MODEL` (OpenAI 兼容接口, 见 `src/retrieval/embedding-http.ts`), 配完重跑同一条命令做对比。
