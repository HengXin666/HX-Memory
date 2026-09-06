# 架构

> 目的: 说明 HX-Memory 为什么这样分层, 以及每一层的边界。源码映射见下。不写实现细节 (实现细节在代码注释与 ADR)。

## 动机 (为什么自建)

对比过 VCP / OpenViking / agentmemory / StrataGate / ReMe / Basic Memory / obsidian-second-brain / 腾讯 Hy-Memory:

- 单项目都能覆盖一部分需求, 但没有一个同时满足: **自维护 (不整包引入) + 可插拔 (1 套 API 多 harness/多存储) + 跨项目推广 (具体踩坑 → "我所有容器都有并发问题")**。
- 各家的"具体 → 摘要抽象"机制 (OpenViking experiences / agentmemory reflect / ReMe dream digest) 都缺三环: **跨项目生效、用户级经验门、规则⇄实例双向链接**。
- 因此本仓库只做一件市面没有的事: 一个薄内核 + 推广引擎, 其余全部 adapter 化。

## 分层

| 层          | 目录              | 职责                                                                        | 依赖        |
| ----------- | ----------------- | --------------------------------------------------------------------------- | ----------- |
| 内核 (Port) | `src/kernel/`     | MemoryEntry/Relation 领域类型; MemoryStore/HarnessAdapter/Generalizer 接口  | 无 (零依赖) |
| 接入层      | `src/adapters/`   | 每个 harness 一个 adapter 实现 HarnessAdapter (dsh 先行, codex/cli 后续)    | kernel      |
| 存储层      | `src/storage/`    | FileBackend (默认: 文件真相 + 派生索引), SqliteBackend, VectorBackend(可选) | kernel      |
| 推广引擎    | `src/generalize/` | 后台聚类 → LLM 抽象 → 候选 rule 队列 → 人工闸门 → 双向链接                  | kernel      |

## 不变量 (架构铁律)

1. 依赖方向单向: kernel 不 import harness/存储; 违反即 bug。
2. 接入层与存储层都是"接口 + 多实现", 内核零改动可换。
3. 真相在文件, 索引可重建; 删索引不影响真相, 删文件要禁止/提示。
4. 双时态 `validAt` / `assertedAt` 必须并存。
5. 推广必须人工闸门: 机器只提议, rule 确认记录 (谁/何时/实例) 必须留存。

## 测试映射

`src/kernel/*` → `tests/s1/*` (纯逻辑, 禁网络); `src/storage/*` + `src/adapters/*` → `tests/s2/*` (临时资源/stub); 完整 DSH 接入 → `tests/s3/*`; 真实 LLM 推广质量 → S4 (CI 定时, 不阻塞 PR)。

## 相关

- [ADR 记录](adr.md): 关键决策与替代方案。
- 工程约束: `.agents/rules/engineering.md`; 文档约束: `.agents/rules/docs.md`。
