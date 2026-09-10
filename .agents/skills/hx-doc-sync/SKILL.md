---
name: hx-doc-sync
description: 改完代码/文档后同步检查: 文档引用是否还指向真实文件、docs 文档是否声明了目的/边界/与代码的关系、Agent Note 是否与实现一致。当改动涉及文件重命名、目录移动、脚本删除或文档正文时使用。
---

# 文档同步检查

文档最常见的失效不是"写得不好", 而是**写得对但指的路径已经不存在**。
本仓库用三道 gate 覆盖, 但 gate 只查机械事实, 语义一致性仍需人来过一遍。

## 先跑 gate (机械事实)

```bash
pnpm run verify-docs                       # 引用可达 + docs 三要素 + 无过程标记
pnpm run verify-agent-note-classification  # Note 结构/分类
pnpm run verify-agent-note-format          # Note 骨架
pnpm run verify-agent-note-coverage        # 非平凡改动是否带 Note
```

全部挂在 `scripts/verify.sh` 与 pre-commit 上; `pnpm run verify` 一次跑完。

## 再人工过一遍 (语义事实)

gate 查不到的四件事, 逐条问自己:

1. **数字是否还有效**: 文档里的实测数字 (延迟、召回率、星标、行数) 标注了日期吗? 变了就更新,
   不能留"上个月的数字"当现状。
2. **Agent Note 是否与实现一致**: `implemented/` 的 Note 必须描述**当前**事实 (路径/默认值/机制)。
   代码改了事实, 同一批改动里改 Note —— 这是 `implemented/AGENTS.md` 的硬要求。
3. **决策是否被推翻**: 推翻结论要**新写一篇**并互相链接, 不能把旧 Note 改写成相反的意思。
4. **职责是否重复**: 同一件事只能有一个家 (见下表)。发现两处都写了全文 → 留一处, 另一处改成链接。

## 事实的"一个家" (本仓库)

| 事实                     | 唯一归属                                       |
| ------------------------ | ---------------------------------------------- |
| 为什么这么做、否决了什么 | `.agents/notes/` (Agent Note)                  |
| 现在怎么用 (对外)        | `README.md`                                    |
| 分层与端口契约           | `docs/architecture-v2.md`                      |
| 市面对标与选型理由       | `docs/open-source-landscape.md`                |
| 宿主可挂的触发点         | `docs/dsh-trigger-points.md`                   |
| 历史决策编号             | `docs/adr.md` (只追加指向 Note 的行, 不再扩写) |
| 用途/命令                | 对应 skill 或 README                           |

## 站外引用怎么标

上游仓库路径、运行时数据文件 (`bindings.json`、`index.sqlite`) 不是本仓库文件,
在**该行末**加 `<!-- verify-docs:allow (原因) -->`。刻意要求显式标注: 让"这是外部引用"
成为作者的有意声明, 而不是 gate 猜出来的豁免。
