# P2-REPORT — 知识库 K1/K2 查询集与 K3 口径

生成: 2026-11-01 20:35 CST。博客根 `/home/hx/Loli/code/HXLoLis/HXLoLi` (本轮经 fs 挂载整份读下 1211 个 .md 到本地镜像后运行; 在原机上把 `--src` 换成博客根即可)。

## 复现

| 命令 | 退出码 | 原始输出前三行 |
|---|---|---|
| `python3 scripts/eval/kb-corpus-census.py --src <博客根>` | 0 | `{`<br>` "all_md_mdx": 1211,`<br>` "mdx": 0,` |
| `node --experimental-strip-types --no-warnings scripts/eval/kb-coverage.ts --src <博客根> --out .tmp/k3` | 0 | `K3=1.0000 (1022/1022 个文件, 4672 个切片, 56756 ms)  warnings=0`<br>`评测页已重生成: …/docs/eval-report.html` (只有两行) |
| `node --experimental-strip-types --no-warnings scripts/eval/kb-retrieval.ts --make-slots --src <博客根>` | 0 | `槽位 120 条 (title 40, detail 40, cross 40); 名额 {"blog":2,"ai-docs":2,"docs":36} / 类`<br>`语料 1022 篇 ({"blog":43,"ai-docs":44,"docs":935}), 可抽 1018 篇 (排除 draft 0, 空占位 4)`<br>`写出 tests/fixtures/eval/kb-queries.jsonl; question 全部留空, 由人填写后再跑评测` |
| `node --experimental-strip-types --no-warnings scripts/eval/kb-retrieval.ts --src <博客根>` | **2** | `查询集 120 条, 其中 120 条 question 为空; EVAL 2.2 要求人写问题, 拒绝打分`<br>`空槽位前 3 个: k001(title) blog/2025/05/07/001-小灶分享.md; k002(title) blog/2025/06/30/01-调教VSCode.md; k003(title) ai-docs/003-AI/010-HX-AI-Review通用AI-CR方案/index.md`<br>`K1/K2 = 未测` |

## 1. K1/K2 查询集: 槽位已建, 问题没有写, K1/K2 仍是「未测」

EVAL 2.2 要求问题由人写, 不用 LLM 从原文生成。我是模型, 我写的问题按定义就是「LLM 生成」, 会把字面检索的分数抬高, 正是 2.2 要防的泄题。所以这一轮**不填问题**, 只做规则里机器该做的部分:

- `scripts/eval/kb-retrieval.ts --make-slots`: 按目录文件数用最大余数法分名额 (每类 40: blog 2, ai-docs 2, docs 36), 每类按 `fnv1a(类别:路径)` 排序确定性抽样, 排除 `draft: true` 和正文 < 50 字的占位, 写出 120 个槽位 `tests/fixtures/eval/kb-queries.jsonl`:
  - `title` 40 条: 一个期望文件, 问题要换掉标题的说法;
  - `detail` 40 条: 一个期望文件 + `section` (那篇里的一个 `##` 小节标题), 问题的答案要在那一节;
  - `cross` 40 条: 两个期望文件 (锚点 + 同一系列目录里最近的另一篇)。搭档是按目录结构选的, 主题未必相关 (例如 k082: `MSVC_ICE` 与 `博客更新日志和计划`), 写问题的人可以改搭档, 但改后仍须 ≥ 2 篇。
- 每行 `question` 和 `author` 留空。评测模式发现任何一条为空就退出码 2, 写「K1/K2 = 未测」, 不会拿占位算数。
- 填完后: `kb-retrieval.ts --src <博客根>` 同步到临时库 (不碰 `~/.dsh/hx-memory`), 用 `retrieveSync({purpose: "recall", kinds: ["doc"], limit: 10})` 检索, 写 `eval-out/K1.json` (Hit@5, 按类分组, 小节级命中另计) 与 `K2.json` (MRR@10), 并刷新评测页。退出码 0 = K1 ≥ 0.80 且 K2 ≥ 0.60, 1 = 未达标。
- 再抽一次会覆盖槽位; 文件里已有人写的问题时 `--make-slots` 拒绝覆盖 (退出码 2), 要加 `--force`。

## 2. K3 口径: 1022, 差额的实际构成和你给的拆分不一样

`kb-corpus-census.py` 的清点 (同 walkMarkdown 规则: 跳过以 `.` 开头的目录和文件、`node_modules`、`build`):

| 项 | 数 | 键 |
|---|---|---|
| blog/ ai-docs/ docs/ 下全部 .md (.mdx 为 0) | **1211** | `all_md_mdx`, `mdx` |
| walkMarkdown 看得见 (= K3 分母) | **1022** (blog 43, ai-docs 44, docs 935) | `walkMarkdown_visible`, `visible_by_dir` |
| 被跳过的隐藏路径 | **189** | `hidden_total` |
| ├ 在 `ai-docs/.hx-staging/` 下 | **145** (其中 5 篇在其内部的 `.hark-bak/`) | `hidden_under_ai-docs/.hx-staging`, `hidden_under_.hark-bak` |
| └ `.hx-staging` 之外的点文件 | **44** (`.hx-mitemite.md` 28, `.hx-info.md` 15, `.hx-persona.md` 1, 都在 ai-docs/ 各篇目录里) | `hidden_dotfiles_*` |
| 看得见但只有 15 字节的占位 | 2 (docs/…/004-使用DockerFile进行微服务部署/index.md, docs/…/005-Xftp远程连接Docker容器/index.md) | `visible_tiny_lt50B` |

和题目给的拆分逐条对:

- **1022 对。** K3 = 1022 / 1022 = 1.00, 本轮在镜像上重跑一致 (4672 个切片)。
- **「.hx-staging 189 篇」不对**: 189 是全部隐藏路径; `.hx-staging` 只占 145, 另 44 个是散在 ai-docs 各篇目录里的 `.hx-*.md` 点文件。
- **「docs/.hark-bak/ 2 个占位」不对**: docs/ 下没有 `.hark-bak` 目录。`.hark-bak` 只在 `.hx-staging/super-agent-design/` 里 (5 篇, 已算在 145 里)。docs/ 下确有 2 个 15 字节的占位 `index.md`, 但它们不是隐藏的, 已经在 1022 里, K3 也把它们算作「已入库」。
- **总数 1213 对不上**: 本轮实数是 1211 = 1022 + 189。差的 2 篇我没有找到来源; 可能是清点时间不同 (博客在变) 或那次把 2 个占位又加了一遍。EVAL.md 写的 1215 同样对不上。

## 3. 判断: `.hx-staging` 不该进语料

理由按分量排:

1. **它是未发布的工作区。** `ai-docs/.hx-staging/.gitignore` 的内容是 `*`, 整个目录不进版本库, 也不进站点构建。EVAL 2.2 明确草稿不进语料和查询; staging 就是草稿的上游。
2. **会制造重复命中。** staging 里的稿子定稿后会搬进 ai-docs/ 正文 (例如 `010-HX-AI-Review通用AI-CR方案` 在两边都有目录), 外加 `.hark-bak/` 备份; 进库后同一内容有 2-3 份, K1/K2 的期望文件会被它的草稿版本抢走排名。
3. **K3 = 1.00 的含义不变才有用。** K3 回答的是「发布了的文章都入库了没有」, 把不会发布的草稿算进分母只会让这个数失去意义。

另外 44 个 `.hx-*.md` 点文件 (每篇的 info / mitemite / persona 元数据) 也不该进: 它们是写作工具的元数据, 不是给人读的文章。

建议把这个口径写死: walkMarkdown 的跳过规则保持不变, 在 kb-coverage.ts 的 K3.json 里加 `excludedHidden: 189` 和按原因的分组 (就是本节的表), 让 1022 和 1211 的差在每次评测里都看得见。这一轮没有改 kb-coverage.ts。

## 4. 已知限制

- K1/K2 仍未测, 要等人写 120 条问题。
- `--make-slots` 的槽位依赖当前博客内容; 博客增删文章后重抽, 槽位会变。抽完就应该冻结这份文件。
- walkMarkdown 只收 `.md`, EVAL 2.2 写的是 `.md/.mdx`; 当前 `.mdx` 为 0 篇, 暂无影响。
