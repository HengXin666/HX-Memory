# Agent Note: 外置引擎只保存投影

Status: implemented

Decision-ID: external-engine-ports

## Code

- `src/external/host.ts`
- `src/external/hindsight.ts`
- `src/adapters/dsh/external-bridge.ts`

## Problem

记忆和知识库被放在同一套自研索引里时, 换一个检索实现就要改字段。引擎自己的 uuid、改写后的事实、切出来的 chunk 一旦变成存储格式, 迁移就等于重做一遍抽取。

调用时机也绑在旧链路上: 要么每轮灌最近原文, 要么等模型自己想起去搜。骂人的原话会落盘, 当轮却没有一条可用的纠正。

## Decision

canonical bundle (`hx-canonical/1`) 是唯一迁移单位。`MemoryEngine` 和 `KnowledgeEngine` 只提供 `reset` + `upsert` + 召回。召回结果必须带回 canonical id, 正文以 bundle 里的记录为准。

默认记忆引擎是 Hindsight, 因为它有 bank 隔离和原生 reflect。Mem0 更轻, 但没有 reflect, 宿主用同一套反思协议补上。默认知识库是 RAGFlow, 因为要收 markdown 引用的图片; LightRAG 只作为更轻的 markdown 备选, 一个进程一个 corpus。

硬门槛是隔离、失效过滤、id 往返。不过线的引擎不能当默认。过线之后, 记忆优先原生 reflect, 知识库优先图片。

挫折不另写词表, 复用 `detectNegative`。技术短语 (垃圾回收、废物利用) 压掉误伤。命中后当轮 `reflect`, 原文不入库; 证据不足就不写纠正。

## Alternatives considered

- 什么都不做 / 复用现有自研索引: 不用再接一套服务, 但每换一个库都要改存储字段, 迁移等于重做抽取。
- 直接把 Hindsight 的 fact 当真相: 少一份文件, 但换到 Mem0 时拿不回原来的正文。
- 每轮派子 agent 沉淀: 看起来自动, 但和下一轮竞态, 也写不进稳定的 id。

## Consequences

换引擎调用 `swapMemory` / `swapKnowledge`, 它们只重放 bundle。引擎宕机时记录留在 `indexState=pending`, 不丢。

DSH 的 `apply` 会 `attachExternalHost`。会话首轮注入开场卡片, 之后每轮按信号召回, 轮末按结论沉淀, 辱骂当轮走 `onUserMessage`。工具 `workspace_memory` 和 `knowledge_search` 走同一宿主。没配 `HX_HINDSIGHT_BASE_URL` / `HX_RAGFLOW_BASE_URL` 时用进程内词面投影, 调用形状不变; 配了地址就用 bakeoff 的默认引擎。Hindsight 的召回是 `POST /memories/recall`, 打到 `/recall` 会 404, 宿主就当成没有记忆。旧的 FileBackend 注入还在, 它服务既有记忆, 不代替这份 canonical。
