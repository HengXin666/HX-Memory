# 外置记忆引擎与知识库

## 目的

把记忆和知识库拆成两套端口。引擎只做检索投影, 换引擎时用同一份 canonical 包重放, 不从引擎内部导出数据。

## 边界

- 记忆回答「这个工作区里定过什么、被纠正过什么」。默认引擎是 Hindsight, 备选是 Mem0。
- 知识库回答「这份文档和它引用的图写了什么」。默认引擎是 RAGFlow, 备选是 LightRAG。LightRAG 一个进程只服务一个 corpus, 并且不索引图片字节。
- 辱骂原话不进记忆。挫折闸门在当轮写入纠正; 证据不足就只提示对齐, 不编规则。
- 这里不替换 DSH 里已经在跑的旧注入链路。新宿主走 `createExternalHost`。

## 与代码的关系

- 端口与宿主: `src/external/ports.ts`, `src/external/host.ts`
- 迁移单位: `src/external/canonical.ts`, `src/external/store.ts`, `src/external/migrate.ts`
- 调用时机: `src/external/policy.ts`
- 引擎适配: `src/external/hindsight.ts`, `src/external/mem0.ts`, `src/external/ragflow.ts`, `src/external/lightrag.ts`
- 默认选择: `src/external/bakeoff.ts`
