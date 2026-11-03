# tests/fixtures/eval/k1k2/verify-gold.py — 一次性机械校验 draft.jsonl 的 gold 侧 (与 k1k2-score.ts --check 互为独立实现)
# 用法: python3 tests/fixtures/eval/k1k2/verify-gold.py [博客根] [draft.jsonl]
import json, os, re, sys
src = sys.argv[1] if len(sys.argv) > 1 else "/home/hx/Loli/code/HXLoLis/HXLoLi"
draft = sys.argv[2] if len(sys.argv) > 2 else "tests/fixtures/eval/k1k2/draft.jsonl"
rows = [json.loads(l) for l in open(draft, encoding="utf8") if l.strip()]
need = ["id", "gold_path", "gold_heading", "question", "why", "difficulty", "source"]
bad, files, ids = [], 0, set()
for r in rows:
    miss = [k for k in need if k not in r]
    if miss: bad.append(f"{r.get('id')}: 缺字段 {miss}")
    if r["id"] in ids: bad.append(f"{r['id']}: id 重复")
    ids.add(r["id"])
    if r["question"] != "": bad.append(f"{r['id']}: question 非空")
    for p in r["gold_paths"]:
        files += 1
        if not os.path.isfile(os.path.join(src, p)): bad.append(f"{r['id']}: 文件不存在 {p}")
    fp = os.path.join(src, r["gold_path"])
    if not os.path.isfile(fp): continue
    raw = open(fp, encoding="utf8").read()
    m = re.match(r"^---\r?\n([\s\S]*?)\r?\n---\r?\n?", raw)
    body = raw[m.end():] if m else raw
    lv, h = r["heading_level"], r["gold_heading"]
    if lv == "title": ok = re.search(r"^title:\s*[\"']?" + re.escape(h) + r"[\"']?\s*$", m.group(1) if m else "", re.M) is not None
    else: ok = re.search(r"^" + ("#" if lv == "h1" else "##") + r"\s+" + re.escape(h) + r"\s*$", body, re.M) is not None
    if not ok: bad.append(f"{r['id']}: 标题不在文件里 [{lv}] {h}")
kinds = {k: sum(1 for r in rows if r["kind"] == k) for k in ("title", "detail", "cross")}
lv = {k: sum(1 for r in rows if r["heading_level"] == k) for k in ("title", "h1", "h2")}
print(f"draft 行数 {len(rows)}; kind {kinds}; 标题层级 {lv}; 校验文件 {files} 个 (含 cross 搭档)")
print(f"question 为空 {sum(1 for r in rows if r['question']=='')}/{len(rows)}; why 为空 {sum(1 for r in rows if r['why']=='')}/{len(rows)}")
print("结果:", "全部通过" if not bad else f"不通过 {len(bad)} 处")
for b in bad: print("  ✗", b)
sys.exit(1 if bad else 0)
