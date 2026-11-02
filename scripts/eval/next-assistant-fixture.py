#!/usr/bin/env python3
"""scripts/eval/next-assistant-fixture.py — 给每条标注样本配「下一条助手消息的首句」(后验特征的输入)。

输入: assistant-cues-extract.py --samples 模式产出的 pairs.jsonl (每条用户原话 -> 下一条 assistant 消息的第一个非空 text 块)。
输出: tests/fixtures/eval/frustration/next-assistant.jsonl, 每行 {"sid", "next_assistant_first"}; 没配到首句的样本写空串。
只截到第一个换行且最多 200 字: 后验特征只看开头, 不需要整段回复入库。

用法: python3 scripts/eval/next-assistant-fixture.py .tmp/ac3/pairs.jsonl [--samples tests/fixtures/eval/frustration/samples.jsonl] [--out tests/fixtures/eval/frustration/next-assistant.jsonl]
退出码: 0 写出; 2 输入缺失。
"""
import json, sys, os

def main(argv):
    if len(argv) < 2 or not os.path.exists(argv[1]):
        print("usage: next-assistant-fixture.py <pairs.jsonl>", file=sys.stderr); return 2
    get = lambda k, d: argv[argv.index(k) + 1] if k in argv else d
    samples = get("--samples", "tests/fixtures/eval/frustration/samples.jsonl")
    out = get("--out", "tests/fixtures/eval/frustration/next-assistant.jsonl")
    pairs = {}
    for l in open(argv[1], encoding="utf-8"):
        if l.strip():
            r = json.loads(l); pairs[r["msg_id"]] = r
    rows, have = [], 0
    for l in open(samples, encoding="utf-8"):
        if not l.strip(): continue
        s = json.loads(l)
        r = pairs.get(s["source"]["msg_id"]) or {}
        t = (r.get("first_text") or "").strip().split("\n")[0][:200]
        have += bool(t)
        rows.append({"sid": s["sid"], "next_assistant_first": t})
    with open(out, "w", encoding="utf-8") as f:
        for r in rows: f.write(json.dumps(r, ensure_ascii=False) + "\n")
    print(json.dumps({"samples": len(rows), "with_first_text": have, "out": out}))
    return 0

if __name__ == "__main__":
    sys.exit(main(sys.argv))
