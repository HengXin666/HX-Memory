# 从 kb-queries.jsonl 的 120 个确定性槽位生成 draft.jsonl (不写 question), 用 --src 下的真实文件取标题并校验
import json, re, sys, os
src, queries, out = sys.argv[1], sys.argv[2], sys.argv[3]
DIFF = {"title": "1", "detail": "2", "cross": "3"}
rows, bad = [], []
for line in open(queries, encoding="utf8"):
    if not line.strip(): continue
    q = json.loads(line); p = q["expect_paths"][0]
    fp = os.path.join(src, p)
    if not all(os.path.isfile(os.path.join(src, x)) for x in q["expect_paths"]): bad.append(q["qid"]+" missing"); continue
    raw = open(fp, encoding="utf8").read()
    m = re.match(r"^---\r?\n([\s\S]*?)\r?\n---\r?\n?", raw)
    body = raw[m.end():] if m else raw
    t = re.search(r"^title:\s*[\"']?(.*?)[\"']?\s*$", m.group(1) if m else "", re.M)
    h1 = re.findall(r"^#\s+(.+?)\s*$", body, re.M); h2 = re.findall(r"^##\s+(.+?)\s*$", body, re.M)
    if q["kind"] == "detail": head, lvl = q["section"], "h2"
    elif t and t.group(1): head, lvl = t.group(1), "title"
    elif h1: head, lvl = h1[0], "h1"
    elif h2: head, lvl = h2[0], "h2"
    else: bad.append(q["qid"]+" no heading"); continue
    if (lvl=="h2" and head not in h2) or (lvl=="h1" and head not in h1): bad.append(q["qid"]+" heading not found"); continue
    rows.append({"id": q["qid"], "kind": q["kind"], "dir": q["dir"], "gold_path": p, "gold_paths": q["expect_paths"],
                 "gold_heading": head, "heading_level": lvl, "question": "", "why": "", "difficulty": DIFF[q["kind"]],
                 "author": "", "source": "tests/fixtures/eval/kb-queries.jsonl#" + q["qid"] + " (kb-retrieval.ts --make-slots, fnv1a 分层抽样)"})
with open(out, "w", encoding="utf8") as f:
    for r in rows: f.write(json.dumps(r, ensure_ascii=False) + "\n")
print(len(rows), "rows; bad:", bad)
