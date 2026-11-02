#!/usr/bin/env python3
"""scripts/eval/assistant-cues-extract.py — 抽「用户原话 → 下一条 assistant 消息第一个 text 块」(ASSISTANT-CUES.md)。

两种抽样 (二选一):
  --bucket <桶 URL>   读桶里全部会话; 排除子代理会话 (出现 subagent/descriptor 事件, 或首条 user/message 的
                      data.source.kind != "user"); 剩下的按「用户原话条数」降序取前 --top 个 (并列按目录名)。
  --samples <samples.jsonl> --sessions <sessions 根 URL>
                      只读人工标注样本里出现过的会话 (source.bucket 里的 <user> 换成 hx), 全部读, 不排除。
口径: 用户原话 = type=user/message 且 data.source.kind=="user"; 下一条 assistant 消息 = 其后第一条 type=assistant/message
(在下一条用户原话之前); 首句 = data.message.content 里第一个 type=text 且非空的块 (strip)。会话整份读, 不设消息条数上限。
会话文件优先 session.v4.jsonl.zstd > v3 > session.jsonl.zstd, 用 zstd -dc 解压。
输出: <out> 每行一条用户原话; <out>.meta.json 记每个会话的判定 (delegated / 用户原话数 / 是否入选)。
"""
import argparse, concurrent.futures as cf, json, subprocess, urllib.parse, urllib.request

PREF = ["session.v4.jsonl.zstd", "session.v3.jsonl.zstd", "session.jsonl.zstd"]


def split(url):
    pu = urllib.parse.urlparse(url)
    return f"{pu.scheme}://{pu.netloc}/fs", pu.path[len("/fs"):], urllib.parse.parse_qs(pu.query)["token"][0]


def ls(base, tok, path):
    u = base + urllib.parse.quote(path) + "?token=" + tok
    return json.load(urllib.request.urlopen(urllib.request.Request(u, headers={"User-Agent": "curl/8.0"}), timeout=120))["items"]


def read_session(base, tok, sdir):
    names = {i["name"]: i["path"] for i in ls(base, tok, sdir) if i["kind"] == "file"}
    f = next((names[n] for n in PREF if n in names), None)
    if not f:
        return None
    u = base + urllib.parse.quote(f) + "?token=" + tok
    pr = subprocess.Popen(["bash", "-c", f"curl -s -A curl/8 --max-time 600 '{u}' | zstd -dc 2>/dev/null"], stdout=subprocess.PIPE)
    rows, cur, has_desc, first_kind = [], None, False, "<none>"
    for line in pr.stdout:
        try:
            o = json.loads(line)
        except Exception:
            continue
        t = o.get("type")
        d = o.get("data") or {}
        if t == "subagent/descriptor":
            has_desc = True
        elif t == "user/message":
            kind = (d.get("source") or {}).get("kind")
            if first_kind == "<none>":
                first_kind = str(kind)
            if kind == "user":
                cur = {"session": sdir.rsplit("/", 1)[1], "bucket": sdir.rsplit("/", 2)[1], "file": f.rsplit("/", 1)[1],
                       "msg_id": d.get("id"),
                       "user": "".join(c.get("text", "") for c in d.get("content") or [] if isinstance(c, dict) and c.get("type") == "text"),
                       "asst_found": False, "asst_turn": None, "asst_step": None, "first_text": None}
                rows.append(cur)
        elif t == "assistant/message" and cur is not None and not cur["asst_found"]:
            m = d.get("message") or {}
            cur["asst_found"] = True
            cur["asst_turn"], cur["asst_step"] = d.get("turn"), d.get("step")
            tb = [c.get("text", "") for c in m.get("content") or [] if isinstance(c, dict) and c.get("type") == "text" and c.get("text", "").strip()]
            cur["first_text"] = tb[0].strip() if tb else None
    pr.wait()
    return {"session": sdir.rsplit("/", 1)[1], "bucket": sdir.rsplit("/", 2)[1], "file": f.rsplit("/", 1)[1],
            "has_subagent_descriptor": has_desc, "first_user_message_source_kind": first_kind,
            "delegated": has_desc or first_kind != "user", "user_msgs": len(rows), "rows": rows}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bucket", default="")
    ap.add_argument("--samples", default="")
    ap.add_argument("--sessions", default="")
    ap.add_argument("--top", type=int, default=20)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    if a.bucket:
        base, root, tok = split(a.bucket)
        dirs = sorted(i["path"] for i in ls(base, tok, root) if i["kind"] == "dir")
    else:
        base, root, tok = split(a.sessions)
        dirs = sorted({root + "/" + json.loads(l)["source"]["bucket"].replace("<user>", "hx") + "/" + json.loads(l)["source"]["session"]
                       for l in open(a.samples, encoding="utf8") if l.strip()})
    with cf.ThreadPoolExecutor(16) as ex:
        sess = [s for s in ex.map(lambda d: read_session(base, tok, d), dirs) if s]
    if a.bucket:
        keep = sorted([s for s in sess if not s["delegated"]], key=lambda s: (-s["user_msgs"], s["session"]))[: a.top]
    else:
        keep = sess
    kept = {s["session"] for s in keep}
    with open(a.out, "w", encoding="utf8") as fo:
        for s in sorted(keep, key=lambda s: s["session"]):
            for r in s["rows"]:
                fo.write(json.dumps(r, ensure_ascii=False) + "\n")
    meta = {"mode": "bucket" if a.bucket else "samples", "top": a.top if a.bucket else None,
            "sessions": [{k: v for k, v in s.items() if k != "rows"} | {"selected": s["session"] in kept} for s in sess]}
    json.dump(meta, open(a.out + ".meta.json", "w", encoding="utf8"), ensure_ascii=False, indent=1)
    print(f"sessions read {len(sess)}, delegated {sum(s['delegated'] for s in sess)}, selected {len(keep)}, user msgs {sum(s['user_msgs'] for s in keep)}")


if __name__ == "__main__":
    main()
