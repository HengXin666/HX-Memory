# 外置记忆引擎与知识库

## 目的

把记忆和知识库拆成两套端口。引擎只做检索投影, 换引擎时用同一份 canonical 包重放, 不从引擎内部导出数据。

## 边界

- 记忆回答「这个工作区里定过什么、被纠正过什么」。默认引擎是 Hindsight, 备选是 Mem0。
- 知识库回答「这份文档和它引用的图写了什么」。默认引擎是 RAGFlow, 备选是 LightRAG。LightRAG 一个进程只服务一个 corpus, 并且不索引图片字节。
- 辱骂原话不进记忆。挫折闸门在当轮写入纠正; 证据不足就只提示对齐, 不编规则。
- DSH `apply` 会调用 `attachExternalHost`。开场卡片、按信号召回、轮末沉淀、辱骂当轮反思都走这个宿主。另外注册 `workspace_memory` 和 `knowledge_search`。
- 没配远端地址时用进程内词面投影 (`lexical`), 这样插件离线也能走同一条调用。配了 `HX_HINDSIGHT_BASE_URL` 就用 Hindsight, 配了 `HX_RAGFLOW_BASE_URL` 和 `HX_RAGFLOW_API_KEY` 就用 RAGFlow。`HX_MEMORY_ENGINE=mem0` 配 `HX_MEM0_BASE_URL`, `HX_KNOWLEDGE_ENGINE=lightrag` 配 `HX_LIGHTRAG_BASE_URL`。
- 旧的 FileBackend 注入仍服务既有记忆。canonical 落在 `<root>/external`。

## 与代码的关系

- 端口与宿主: `src/external/ports.ts`, `src/external/host.ts`
- 迁移单位: `src/external/canonical.ts`, `src/external/store.ts`, `src/external/migrate.ts`
- 调用时机: `src/external/policy.ts`
- 引擎适配: `src/external/hindsight.ts`, `src/external/mem0.ts`, `src/external/ragflow.ts`, `src/external/lightrag.ts`, `src/external/lexical.ts`
- 按环境打开: `src/external/open.ts`
- DSH 接线: `src/adapters/dsh/external-bridge.ts`
- 默认选择: `src/external/bakeoff.ts`
