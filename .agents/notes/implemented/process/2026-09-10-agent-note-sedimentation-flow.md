# Agent Note: Agent Note 沉淀流 (硬约束的方案记录)

Status: implemented

Decision-ID: agent-note-sedimentation-flow

## Code

- `scripts/redlines/agent_notes.py`
- `scripts/verify-agent-note-coverage.ts`
- `scripts/lib/legacy-note-coverage.ts`

## Problem

本仓此前只用 `docs/adr.md` 逐条追加编号决策, 没有强制记录被否掉的替代方案或把理由绑定到真实声明. 分层, 索引和嵌入器选择在跨会话协作中反复争论, 已有结论容易丢失

格式与分类检查可以约束文档形状, 但不能证明代码与决策双向对应. 把没有源码约束的记录另存一套参考目录还会分散维护入口

## Decision

本仓使用 v2 双向图记录同一条决策的当前理由, 每篇 active note 有唯一 Decision-ID, 精确 Code 列表及对应 AST 声明锚点. 决策统一维护在 `.agents/notes`, 失去本仓有效代码约束的记录直接退役, 有指导价值的理由先迁入存活决策并修复入站引用. 冻结 archived 内容保持原样, 新流程不新增永久归档

本地 `scripts/redlines/agent_notes.py` 委托 vendored 实现, diff / all / staged 使用同一严格扫描器. package scripts, pre-commit 和 Stop hook 均调用它, 不通过 allow-missing 或跳过环境变量放行. 旧 TypeScript 命令也委托 v2, 历史 fixture helper 仅为归档浏览与旧测试保留, 不承担当前判定

GitHub Diff / Full 保存完整诊断, Report 在代码片段评论. 综合代码验证中的 Agent Notes 步骤在 GitHub 使用同一收集器, 依赖故障与违规都保留报告并容错完成; 本地保持非零退出码. 新迁移边界见 [v2 adoption](2026-10-08-repository-agent-notes-v2-adoption.md)

## Alternatives considered

- 什么都不做 / 复用现有: 不增加维护成本, 但编号日志和宽松格式检查不能证明声明与理由互相对应, 无关 note 仍能掩盖代码变更
- 只检查格式与分类: 接入成本低, 但不能识别断链和单边改动, 因此使用精确路径, AST 归属与旧新关系图
- 只靠自觉更新记录: 不需要工具依赖, 但跨会话协作容易漏写, 因此本地 hook 与 CI 共用扫描器
- 另建参考记录目录: 能保留没有源码落点的旧材料, 但会分散当前决策和测试证据, 因此使用现有 notes 树和 Git 历史
- 按年龄或数量自动归档: 清理容易自动化, 但会删除仍然有指导价值的理由, 因此退役前核对现存约束并迁移有效理由

## Consequences

理由成为精确关联源码的当前决策资产. 代价是固定版本 parser 的开发工具依赖和双边维护成本; 发布库的运行时依赖仍保持原有契约. CI 成功表示报告流程完成, 不证明决策语义已被独立审核

## Testing

vendored Python 与报告器测试验证真双链, 断链, 单边变更, 精确暂存区及 CI 容错. 原有 TypeScript fixture 测试只验证历史读者 API, 不作为 v2 放行证据

2026-10-08 的独立隔离试验中, 有效迁移提交 `a0bebad8f5e20df7bd7a5fac5dd73acfa243b27b` 的 all, diff, staged 均退出 0. 故障提交 `6ca1068f28ec4a40ed8825c6668409d5b1f0a19d` 删除类型声明的反向引用, 三个本地模式均退出 1 并报告 anchor-cardinality 和两项 code-only-diff. CI 对同一故障退出 0, JSON 保留 `ok:false` 与原始诊断

18 项报告器测试使用模拟 GitHub API, 验证行内评论, 提交评论与失败处理, 未发送真实评论. 原始试验提交位于 `/tmp/hx-agent-notes-v2-adoption-19r60tjd`, 门禁证据读取本篇现存决策
