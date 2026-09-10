# AGENTS.md — Agent Notes

Agent Note 是 agent 写的 RFC: 保留**动机、被否掉的替代方案、代价与收益、以及"由什么钉住"**的持久记录。

规则全文见 [README.md](README.md); 格式由 `scripts/verify-agent-note-format.ts` 强制, 结构由 `scripts/verify-agent-note-classification.ts` 强制, "非平凡改动必须带 Note"由 `scripts/verify-agent-note-coverage.ts` 强制 —— 三个 gate 都挂在 `scripts/verify.sh` 与 CI 上, 不是靠自觉。

**每次新增 Note 都要做一次 supersede 检查**: 在活跃树里搜同一决策/机制的旧 Note, 判定是全部还是部分取代; 全部取代的已实施 Note 在同一改动里归档到 `archived/`, 部分取代的保持活跃并互相链接。

`archived/` 下的文件是**冻结的历史快照**: 永远不要编辑, 也不要当作现状的依据。
