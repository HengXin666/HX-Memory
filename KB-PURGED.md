# KB-PURGED.md: 知识库清空状态 (2026-11-02 22:00 CST)

## 1. 结论: 宿主已真删, 六条校验全过

### 1.1 执行
命令 (经 /fs/exec, cwd=/home/hx/Loli/code/HXLoLis/components/HX-Memory):
`node --experimental-strip-types --no-warnings scripts/kb-purge.ts --apply`

exec 返回: ok=true, code=0, stderr 为空。stdout 原文:

```
① 备份前: {"total":6045,"active":5959,"kb":4672,"fts":6045,"byKind":{"context":700,"decision":92,"fact":30,"lesson":440,"pattern":74,"preference":18,"rule":19}}
  备份快照: {"total":6045,"active":5959,"kb":4672,"fts":6045,"byKind":{"context":700,"decision":92,"fact":30,"lesson":440,"pattern":74,"preference":18,"rule":19}}
  ✓ 备份完成并核对: /home/hx/.dsh/hx-memory-backup-kbpurge-20261102
② 选中 4672 条 (source kb: 且 kind doc), 分布在 12 个真相文件; source kb: 但不是 doc 的 0 条不动
③ removeMany: {"found":4672,"blocksRemoved":4672,"mode":"hard","ms":11114}
④ 校验:
  ✓ kb 残留为 0  kb=0
  ✓ 对话沉淀逐 kind 不少  {"context":700,"decision":92,"fact":30,"lesson":440,"pattern":74,"preference":18,"rule":19} → {"context":700,"decision":92,"fact":30,"lesson":440,"pattern":74,"preference":18,"rule":19}
  ✓ FTS 行数 = memories 行数  fts=1373 memories=1373 孤儿=0
  ✓ tags/entities/relations.from 无孤儿  {"fts":0,"tags":0,"entities":0,"relationsFrom":0,"relationsTo":0}
  ✓ 真相文件里无 source: kb:  0 个文件
  ✓ 从真相重建后 doc 仍为 0 (不复活)  重建 total=1373 kb=0
⑤ panel.json 的知识库来源已清空 (原文件备份在 panel.json.bak)
⑥ 报告: /home/hx/.dsh/hx-memory-backup-kbpurge-20261102/kb-purge-report.md

✓ 全部校验通过
```

### 1.2 删后核验 (另一条 exec, 直接读宿主 index.sqlite)
命令: `python3 -c` 查 `~/.dsh/hx-memory/index.sqlite` 的 count(*), sum(source like 'kb:%'), pragma integrity_check。code=0。

```
total 1373
kb 0
integrity ok
```

与预期一致: total=1373, kb=0, integrity=ok。

### 1.3 备份与副作用
- 本次备份: `/home/hx/.dsh/hx-memory-backup-kbpurge-20261102` (报告 kb-purge-report.md / .json 在其中)。
- 更早备份仍在: `/home/hx/.dsh/hx-memory-backup-kbpurge-20261101`。
- 脚本清空了 panel.json 的知识库来源, 原文件在 `panel.json.bak`。
- 对话沉淀 (含 context 700 条) 未动。

### 1.4 面板清空按钮
`DELETE /api/kb/purge` (scripts/panel-server.ts) 以子进程运行同一个 `scripts/kb-purge.ts --apply --root <记忆根> --backup <目录>`, 无第二套删除实现。
重启后 (36100) 实测: `GET /api/kb/purge` → 200 `{"job":null,"running":false}`; `GET /api/decay` → 200, 原 404 已消失。

## 对照: 演练: 在真实记忆根拷贝上跑同一命令 (2026-11-01, exit=0)

```
① 备份前: {"total":6045,"active":5959,"kb":4672,"fts":6045,"byKind":{"context":700,"decision":92,"fact":30,"lesson":440,"pattern":74,"preference":18,"rule":19}}
  备份快照: {"total":6045,"active":5959,"kb":4672,"fts":6045,"byKind":{"context":700,"decision":92,"fact":30,"lesson":440,"pattern":74,"preference":18,"rule":19}}
  ✓ 备份完成并核对: /tmp/bk2
② 选中 4672 条 (source kb: 且 kind doc), 分布在 12 个真相文件; source kb: 但不是 doc 的 0 条不动
③ removeMany: {"found":4672,"blocksRemoved":4672,"mode":"hard","ms":34475}
④ 校验:
  ✓ kb 残留为 0  kb=0
  ✓ 对话沉淀逐 kind 不少  {"context":700,"decision":92,"fact":30,"lesson":440,"pattern":74,"preference":18,"rule":19} → {"context":700,"decision":92,"fact":30,"lesson":440,"pattern":74,"preference":18,"rule":19}
  ✓ FTS 行数 = memories 行数  fts=1373 memories=1373 孤儿=0
  ✓ tags/entities/relations.from 无孤儿  {"fts":0,"tags":0,"entities":0,"relationsFrom":0,"relationsTo":0}
  ✓ 真相文件里无 source: kb:  0 个文件
  ✓ 从真相重建后 doc 仍为 0 (不复活)  重建 total=1373 kb=0
✓ 全部校验通过
exit=0
```

预期结果: total 从 6045 变为 1373 (含 86 条 shadow), active 为 1287, kb 为 0。

宿主执行之后, 把输出贴到这一节下面, 就能替换这份演练记录。
