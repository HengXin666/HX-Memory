# PANEL-FIX — 清空知识库 (用户选 B)

> 状态 2026-11-01 22:3x CST: **实机尚未删除任何东西** (至少不是本说明的作者删的)。

两路实现撞车了, 先停下对齐, 避免两个人同时改同一批文件:

- **宿主上已有的一路** (另一个工作者写的): `scripts/kb-purge.ts` + `src/storage/bulk-remove.ts` + `FileBackend.removeMany()` + `markdown-codec.removeBlocksFromFile` + `tests/s2/bulk-remove.test.ts`。报告写到 `<备份目录>/kb-purge-report.{json,md}`。
- **沙箱里的另一路** (本说明作者): 同样的「备份 → 摘真相块 + 一个事务删索引 → 校验」, 外加面板的 `DELETE /api/kb/purge` + 「清空知识库」按钮 (二次确认, 手输确认词) + 重写的前端与预构建 `scripts/panel.dist.html`。在真实记忆根的拷贝上演练过: 删 4672、剩 1373、无孤儿、integrity ok、真相重建后 kb 仍为 0。**这些文件没有写进宿主**, 以免覆盖上面那一路。

对宿主那一路的复核意见 (未改它的代码):

1. `removeMany` 的 hard 路径复用 `IndexWriter.deleteEntry`, 只删 `relations.from_id`。别的记忆指向被删条目的**入边**会留成孤儿 (第 3 条校验要防的正是这个)。真库实测这类入边是 0 条, 所以这次不会触发, 但通用实现应在同一事务里删 `to_id`, 或改写对方记忆的 relations。
2. 面板部分 (四) 宿主上还没有: `scripts/panel-server.ts` 没有 `DELETE /api/kb/purge`, `scripts/panel-app.tsx` 仍是旧版。
3. 用户要求的第 5 条 (面板 `/api/overview` 的 total 与 recent) 需要 overview 返回 `total` / `recent`; 删完后按存活口径 total 应为 1287, `select count(*) from memories` 为 1373 (含 86 条 shadow)。

等用户定下由哪一路继续, 再合并。

## 演练数据 (另一路在真实记忆根拷贝上跑出来的实测量, 保留备查)

下面这些数字是"沙箱那一套实现"在 `~/.dsh/hx-memory` 的完整拷贝上跑出来的, 那套代码没有进宿主.
数字本身是这个库在 2026-11-01 的真实形状, 对本路实现同样有参考价值: 删 4672 条 kb, 应剩 1373 条,
非 kb 指纹 `5f1fb8d1...` 必须不变.

### 演练过程与读数

拷贝来源 `/home/hx/.dsh/hx-memory` (2026-11-01, 含 index.sqlite / -wal / -shm 与全部真相目录), 记忆根与备份路径已替换为占位符。

##### 删除前读数

```
{
  "total": 6045,
  "kb": 4672,
  "nonKb": 1373,
  "nonKbFingerprint": "5f1fb8d148e755e8c147754d17790e677b47918e7c3f70f22e2b6e2e916adc66",
  "orphans": 0,
  "byKind": "context|active|663\ncontext|shadow|37\ndecision|active|69\ndecision|shadow|23\ndoc|active|4672\nfact|active|24\nfact|shadow|6\nlesson|active|434\nlesson|shadow|6\npattern|active|71\npattern|shadow|3\npreference|active|17\npreference|shadow|1\nrule|active|9\nrule|shadow|10",
  "nonKbByKind": "context|active|663\ncontext|shadow|37\ndecision|active|69\ndecision|shadow|23\nfact|active|24\nfact|shadow|6\nlesson|active|434\nlesson|shadow|6\npattern|active|71\npattern|shadow|3\npreference|active|17\npreference|shadow|1\nrule|active|9\nrule|shadow|10",
  "integrity": "ok",
  "truthEntries": 6045,
  "truthKb": 4672
}
```

##### 备份 `<演练备份目录>`

| 文件 | 字节 | sha256 |
|---|---|---|
| index.sqlite | 50855936 | 95ec9ae9f09e46de |
| index.sqlite-wal | 4865752 | c29dfe113424f3da |
| index.sqlite-shm | 32768 | 5dd4943f68467f4c |
| index.snapshot.sqlite | 49614848 | 53a6fe52f9893a7e |
| daily/ digest/ rules/ | 0 | (目录, 见 truthEntr |

快照读数 (在快照的临时副本上打开, 不碰备份本身), verified=true:

```
{
  "total": 6045,
  "kb": 4672,
  "nonKb": 1373,
  "nonKbFingerprint": "5f1fb8d148e755e8c147754d17790e677b47918e7c3f70f22e2b6e2e916adc66",
  "orphans": 0,
  "byKind": "context|active|663\ncontext|shadow|37\ndecision|active|69\ndecision|shadow|23\ndoc|active|4672\nfact|active|24\nfact|shadow|6\nlesson|active|434\nlesson|shadow|6\npattern|active|71\npattern|shadow|3\npreference|active|17\npreference|shadow|1\nrule|active|9\nrule|shadow|10",
  "nonKbByKind": "context|active|663\ncontext|shadow|37\ndecision|active|69\ndecision|shadow|23\nfact|active|24\nfact|shadow|6\nlesson|active|434\nlesson|shadow|6\npattern|active|71\npattern|shadow|3\npreference|active|17\npreference|shadow|1\nrule|active|9\nrule|shadow|10",
  "integrity": "ok",
  "truthEntries": 6045
}
```

##### 删除 (FileBackend.purgeBySourcePrefix("kb:"))

```
{
  "prefix": "kb:",
  "matched": 4672,
  "byKind": {
    "doc": 4672
  },
  "truthBlocksRemoved": 4672,
  "files": [
    {
      "file": "daily/2026-06-13.md",
      "blocks": 4058
    },
    {
      "file": "daily/2026-10-07.md",
      "blocks": 442
    },
    {
      "file": "daily/2026-10-08.md",
      "blocks": 54
    },
    {
      "file": "daily/2026-09-29.md",
      "blocks": 33
    },
    {
      "file": "daily/2026-09-27.md",
      "blocks": 20
    },
    {
      "file": "daily/2026-10-09.md",
      "blocks": 18
    },
    {
      "file": "daily/2026-09-13.md",
      "blocks": 12
    },
    {
      "file": "daily/2026-10-31.md",
      "blocks": 11
    },
    {
      "file": "daily/2026-10-06.md",
      "blocks": 11
    },
    {
      "file": "daily/2026-10-27.md",
      "blocks": 6
    },
    {
      "file": "daily/2026-09-11.md",
      "blocks": 4
    },
    {
      "file": "daily/2026-09-06.md",
      "blocks": 3
    }
  ],
  "incomingStripped": [],
  "rows": {
    "memories": 4672,
    "fts": 4672,
    "relations": 0,
    "tags": 3639,
    "entities": 25039
  }
}
```

##### 校验

**1. kb 条目清零** — PASS (期望 0)

```
$ sqlite3 <演练记忆根>/index.sqlite "select count(*) from memories where source like 'kb:%'"
0
```

**2. 总行数 = 删除前的非 kb 行数** — PASS (期望 1373)

```
$ sqlite3 <演练记忆根>/index.sqlite "select count(*) from memories"
1373
```

**3. 无孤儿 relation** — PASS (期望 0)

```
$ sqlite3 <演练记忆根>/index.sqlite "select count(*) from relations where from_id not in (select id from memories) or to_id not in (select id from memories)"
0
```

**4. integrity_check** — PASS (期望 ok)

```
$ sqlite3 <演练记忆根>/index.sqlite "pragma integrity_check"
ok
```

**4b. FTS 行数 = memories 行数** — PASS (期望 1373)

```
$ sqlite3 <演练记忆根>/index.sqlite "select count(*) from memories_fts"
1373
```

**4c. 按 kind/status 分布 = 删除前非 kb 部分的分布** — PASS (期望 context|active|663 ; context|shadow|37 ; decision|active|69 ; decision|shadow|23 ; fact|active|24 ; fact|shadow|6 ; lesson|active|434 ; lesson|shadow|6 ; pattern|active|71 ; pattern|shadow|3 ; preference|active|17 ; preference|shadow|1 ; rule|active|9 ; rule|shadow|10)

```
$ sqlite3 <演练记忆根>/index.sqlite "select kind, status, count(*) from memories group by kind, status order by kind, status"
context|active|663
context|shadow|37
decision|active|69
decision|shadow|23
fact|active|24
fact|shadow|6
lesson|active|434
lesson|shadow|6
pattern|active|71
pattern|shadow|3
preference|active|17
preference|shadow|1
rule|active|9
rule|shadow|10
```

**6. 非 kb 条目指纹不变 (id|kind|source|status 排序后 sha256)** — PASS (期望 相同)

```
$ node: counts().nonKbFingerprint
before=5f1fb8d148e755e8c147754d17790e677b47918e7c3f70f22e2b6e2e916adc66
after =5f1fb8d148e755e8c147754d17790e677b47918e7c3f70f22e2b6e2e916adc66
```

**7. 真相文件里也没有 kb 条目 (rebuild 不会复活)** — PASS (期望 truthKb=0 且 truthEntries = 删除前 - 删除前truthKb)

```
$ node: scanTruth(root) 计 source 以 kb: 开头的条目
truthEntries=1373 truthKb=0 (删除前 6045 / 4672)
```

##### 还原 (只在需要时)

```bash
# 先停掉 DSH 与面板 (它们持有 index.sqlite), 再执行:
cp <演练备份目录>/index.snapshot.sqlite <演练记忆根>/index.sqlite && rm -f <演练记忆根>/index.sqlite-wal <演练记忆根>/index.sqlite-shm
rm -rf <演练记忆根>/daily && cp -a <演练备份目录>/daily <演练记忆根>/daily
rm -rf <演练记忆根>/digest && cp -a <演练备份目录>/digest <演练记忆根>/digest
rm -rf <演练记忆根>/rules && cp -a <演练备份目录>/rules <演练记忆根>/rules
```


##### 5. 面板 /api/overview (演练: 面板指向删除后的拷贝)

```
$ curl -s http://127.0.0.1:36100/api/overview   # 字段摘取
total = 1287
stats.dialog.total = 1287  byKind = {"lesson": 434, "context": 663, "decision": 69, "fact": 24, "preference": 17, "pattern": 71, "rule": 9}
stats.kb.total = 0
stats.all = 1287
recent kinds = ['lesson', 'context', 'lesson', 'lesson', 'lesson', 'context', 'lesson', 'lesson', 'context', 'context']
memory/recent 30 条 kind 分布 = {'lesson': 13, 'context': 17}
```

另外: 在删除后的拷贝上重新打开 `FileBackend` 并强制 `rebuildFromFiles()`, 结果仍是 1373 行、kb 0 行; `verify()` = `{"ok":true,"truth":1373,"index":1373,"fullText":1373,"problems":[]}`。tags / entities / memories_fts 里指向不存在 id 的行都是 0。

