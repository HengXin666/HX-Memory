# CHECKPOINT — HX-Memory 盲审 (审计方)

更新: 2026-11-02 23:18 CST。写给换号后接手审计的人。会话历史看不到, 以本文件和 BLIND-AUDIT*.md 为准。

## 已完成
- **BLIND-AUDIT.md** (第一轮, 3/10)。
- **BLIND-AUDIT-2.md** (第二轮, 核验 FIX-ROUND-1, 22:47 写入, 22172 字节): **4/10, 不能接进工作流**。
  - 修好了: 不可复现 (Node 26 下 kb-coverage 退出码 0, `K3=1.0000`); 选型规则改严 (E 淘汰, 线上用 A); docs-gate 全绿 (`verify-docs:allow` 判为正当豁免)。
  - 部分修好: 检索有用性 (M2 代理 strict 0.004 / 安慰剂 0.000, loose 0.249 / 安慰剂 0.130; K1/K2 未测); 挫折闭环 (A1 0.269, 判官未配, C1 n=0, 没有 correction-effect.ts); 工程纪律。
  - 没修: 插件关闭 536 小时, 线上 dist 是旧构建; **0 次提交**。
  - verify-structure 共 11 处: 8 处 HEAD 上已有, 3 处新引入 (panel-server 899 行, kb-sync 手写 shadow, kb-sync 悬空)。
  - 撤回上轮一个疑点: ai-docs 非隐藏文件是 44 篇, 上轮的 88 是我数错了。
- 截至 23:18, `git log -1` 仍是 `62ef9a7` (Oct 31), 作者还没有提交。

## 正在做
- 无。第二轮已交付。下面是第三轮 (BLIND-AUDIT-3.md) 的任务, 尚未开始。

## 下一步 (BLIND-AUDIT-3.md)
1. **先定基线**: 跑 `git log -5 --format='%h %ad %s'`。
   - 有新 commit: 以最新 commit 为基线审, 记下 hash。工作区相对它的脏改动单独列出, 不计入评分。
   - 仍为 62ef9a7: 在报告开头写明「无基线」, 这本身就是扣分项。
2. 复跑第二轮的全部命令 (见 BLIND-AUDIT-2.md 各节), 看 BLIND-AUDIT-2 指出的问题是否被处理: 提交、`.hark-tmp/` 与 `bf-trial1.json`、单测、correction-effect.ts、kb-sync 的 shadow 与悬空、tsconfig 排除。
3. **专项: 外部参考「大肥鱼记忆插件评测 - 全军覆没」**
   - 来源: https://www.xiaoheihe.cn/app/bbs/link/932b72c08233
   - 正文是长图, 用户那边取不到。先试 web_fetch 一次, 取不到就只用下面的标题和评论。
   - 已知内容: 副标题「没有一家打赢最朴素的 qwen 向量检索和重排」; 第二期 soul2.0 重测, 仍输; 评论「纯 rag(+reranker) 就已经很好用」; 高赞评论「知识库当记忆: 不限容量, 不注入上下文, 原文切片, 向量检索」。
   - 要回答 4 问:
     - (1) 本项目评测集相对「朴素向量 + 重排」有没有说服力。M5、K3、1468 条单测、回归 15/15 都只是工程正确性指标, 不是有用性指标。有没有做过 naive baseline 对照? 没有就算设计上的根本缺失。
     - (2) 给 -2「检索有用性」一个**可执行的加分判据**: 同一查询集、同一语料、同一 top-k, hybrid 对比 naive (qwen embedding + reranker)。查询集要人写, 不能被 docs/ 主导; 要有判官 + 人工复核的 M2。给出具体阈值。
     - (3) naive 赢 / hybrid 赢分别怎么解读, 赢多少才有意义 (要求置信区间不重叠, 或配对 bootstrap 显著)。
     - (4) 评 EVAL-CRITIQUE.md 的五条自审: 挫折集 69% 来自一个项目; K1/K2 的 90% 在 docs/; M2 宽松口径一半是安慰剂巧合; 回归 16 条在选型时用过; 第五条先读原文确认。判断自审是否诚实、是否足够, 并补上漏掉的偏差。候选:
       - 单标注人, 没有 kappa
       - 注入账本只覆盖插件关闭前 10 天
       - M2 strict 的 4-gram 50% 门槛效度不明
       - K3 只测入库, 不测可检索
       - kb-sync 没接进产品
       - 没有语义检索, K1/K2 实际只测字面
       - 评测集由写代码的 agent 构造
4. 写 BLIND-AUDIT-3.md, 用 fs 通道 PUT 上去, 结构沿用一至五节, 加一节「六 外部参考专项」。

## 已知坑
- 执行通道: 从审计沙箱访问 `http://127.0.0.1:8920` 不通, 要用 `https://fs.lolioa.com/fs/exec?token=…` (token 与读写通道相同)。POST 的 JSON 里 cwd 必须在 HX-Memory 目录下。
- exec 不走 shell: 不支持管道和 `&&`。`find -name` 的参数会被展开出错, 改用 `python3 -c`。`git check-ignore` 不在白名单。
- 读写通道: 用 PUT 写文件 (body 为原文), 返回 `{"ok":true,"created":…}`。
- 评测脚本有副作用: train-frustration 会重写 `src/frustration/model.ts`; 各脚本会重写 `eval-out/*.json` 和 `docs/eval-report.html`。报告里要声明。
- 工作区在审计期间会被作者修改: 第二轮中 memory-recall.ts 在 22:43 被改过。记录 mtime, 以 commit 为准。
- 面板在 127.0.0.1:36100, 只能在宿主上用 `node -e 'fetch(...)'` 探测。
