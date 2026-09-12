#!/usr/bin/env python3
"""mk_cases.py - deterministic (no-LLM) tiered case generator for head-to-head
memory-system comparison.

Reads .tmp/bench/corpus.json (the neutral export) and emits cases.json where every
case is *machine-verifiable* (gold = memory ids) and every tier is labelled, so the
report can be read per-tier instead of as one misleading average.

Tiers
  lexical_unique : query is a substring unique to one entry   -> recall CEILING probe
  lexical_shared : query is a rare term shared by exactly N entries -> DISCRIMINATIVE
  temporal_update: question about "latest" fact; gold = newest entry, older ones are
                   distractors -> tests knowledge-update / recency
  multihop       : 2 entries joined by a shared entity/tag/project; gold = both
  abstention     : topic absent from the corpus, keyword-leak machine-checked

Usage:
  python3 mk_cases.py corpus.json cases.json [--per-tier N] [--seed 42]
"""
from __future__ import annotations
import json, re, sys, random, argparse, collections, pathlib

STOP = set("""的 了 是 在 和 与 及 或 我 你 他 她 它 们 这 那 有 无 不 要 会 能 可以 把 被 对 从 到 为 以 一个 一条 以及 但是 因为 所以 如果 就 都 也 还""".split())

def tokens(text: str) -> list[str]:
    """Latin words + CJK bigrams - a cheap, dependency-free tokenizer."""
    out = []
    for m in re.finditer(r"[A-Za-z][A-Za-z0-9_.\-]{2,}", text):
        out.append(m.group().lower())
    cjk = re.findall(r"[\u4e00-\u9fff]", text)
    out += ["".join(cjk[i:i+2]) for i in range(len(cjk)-1)]
    return [t for t in out if t not in STOP]

def probe_for(text: str, others_text: str, min_len=8, max_len=24) -> str | None:
    """Longest substring near the start that is unique to this entry (high precision)."""
    for pos in (0.05, 0.2, 0.35, 0.5, 0.7):
        start = int(len(text) * pos)
        for ln in range(max_len, min_len - 1, -2):
            s = text[start:start+ln].strip()
            if len(s) < min_len or re.fullmatch(r"[\W_]+", s or ""):
                continue
            if others_text.find(s) == -1:
                return s
    return None

def first_sent(t: str, n: int = 90) -> str:
    return re.split(r"[。;；\n]", t)[0][:n]

def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("corpus"); ap.add_argument("out")
    ap.add_argument("--per-tier", type=int, default=120)
    ap.add_argument("--seed", type=int, default=42)
    a = ap.parse_args()
    rnd = random.Random(a.seed)

    corpus = json.loads(pathlib.Path(a.corpus).read_text())
    ents = [e for e in corpus["entries"] if e["content"].strip()]
    all_text = "\n".join(e["content"] for e in ents)
    by_id = {e["id"]: e for e in ents}

    # inverted index over cheap tokens
    inv = collections.defaultdict(set)
    for e in ents:
        for t in set(tokens(e["content"])):
            inv[t].add(e["id"])

    cases, seen_q = [], set()
    def add(tier, q, expect, note, secondary=None):
        if not q or q in seen_q: return False
        seen_q.add(q)
        cases.append({"id": f"c-{tier}-{len(cases):04d}", "type": tier, "query": q,
                      "expect": expect, "secondary": secondary or [], "note": note})
        return True

    # ---- tier 1: unique lexical probe (ceiling control) ----
    n = 0
    for e in ents:
        if n >= a.per_tier: break
        others = all_text.replace(e["content"], "", 1)
        p = probe_for(e["content"], others)
        if p: n += add("lexical_unique", p, [e["id"]], "唯一子串: 天花板对照, 不应有区分度")

    # ---- tier 2: shared rare term (discriminative) ----
    # a term appearing in exactly K entries (2..6): the system must rank the right one first
    cands = [(t, ids) for t, ids in inv.items() if 2 <= len(ids) <= 6 and len(t) >= 4]
    rnd.shuffle(cands)
    n = 0
    for t, ids in cands:
        if n >= a.per_tier: break
        # gold = the entry that mentions the term most often (most specific); distractors = the rest
        gold = max(ids, key=lambda i: by_id[i]["content"].lower().count(t))
        rest = sorted(ids - {gold})
        if len(rest) < 1: continue
        q = f"{t} " + first_sent(by_id[gold]["content"], 40)
        if add("lexical_shared", q, [gold], f"共享词 {t!r} 出现在 {len(ids)} 条中, 需排序区分",
               secondary=rest[:3]): n += 1

    # ---- tier 3: temporal / knowledge update ----
    # group by project, order by assertedAt; ask for the newest about a keyword
    by_proj = collections.defaultdict(list)
    for e in ents: by_proj[e.get("project") or "_global"].append(e)
    n = 0
    for proj, group in by_proj.items():
        if len(group) < 3: continue
        group = sorted(group, key=lambda e: e["assertedAt"])
        for newer in group[2:]:
            if n >= a.per_tier: break
            older = [e for e in group if e["assertedAt"] < newer["assertedAt"]]
            ts = sorted({e["assertedAt"][:10] for e in older})
            if not ts: continue
            # gold = newest; distractors = strictly older entries in the same project
            q = (f"截至 {newer['assertedAt'][:10]}, 关于 {proj} 项目最新的一条"
                 f"{newer['kind']} 是怎么说的?")
            if add("temporal_update", q, [newer["id"]],
                   f"更新类: gold 为最新({newer['assertedAt'][:10]}), {len(older)} 条更早的为干扰",
                   secondary=[e["id"] for e in older[-3:]]):
                n += 1

    # ---- tier 4: multi-hop via shared entity/tag/project ----
    n = 0
    pairs = []
    for t, ids in inv.items():
        if len(ids) >= 2:
            for i in sorted(ids):
                for j in sorted(ids):
                    if i < j: pairs.append((i, j))
    rnd.shuffle(pairs)
    for i, j in pairs:
        if n >= a.per_tier: break
        # need a *different* shared token so the query is answerable
        si, sj = set(tokens(by_id[i]["content"])), set(tokens(by_id[j]["content"]))
        shared = (si & sj)
        if len(shared) < 2: continue
        kw = sorted(shared, key=len, reverse=True)[0]
        q = f"哪些记忆同时涉及 {kw}? (需综合多条)"
        if add("multihop", q, sorted({i, j}), f"多跳: 由共享词 {kw!r} 连接的两条"): n += 1

    # ---- tier 5: abstention, keyword leakage machine-checked ----
    ABSTAIN = [("Rust 的 tokio 运行时怎么选", ["tokio", "rustc"]),
               ("Kubernetes HPA 扩缩容阈值怎么调", ["kubernetes", "hpa"]),
               ("MySQL InnoDB 间隙锁排查", ["innodb", "mysql"]),
               ("SwiftUI 的 @StateObject 生命周期", ["swiftui"]),
               ("CUDA shared memory bank conflict", ["cuda"])]
    low = all_text.lower()
    for q, keys in ABSTAIN * max(1, a.per_tier // max(1, len(ABSTAIN))):
        if sum(1 for c in cases if c["type"] == "abstention") >= a.per_tier: break
        leaked = [k for k in keys if re.search(r"(^|[^a-z])" + re.escape(k) + r"([^a-z]|$)", low)]
        add("abstention", q, [], "弃权: 语料中无相关内容" + (" | 泄漏!:" + ",".join(leaked) if leaked else ""))

    out = {"schema": "hxmem-cases/2", "seed": a.seed, "corpus": pathlib.Path(a.corpus).name,
           "metrics": {
               "recall@k": "|top-k ∩ gold| / |gold| (gold 为空时不计入检索均值)",
               "mrr": "首个 gold 的排名倒数",
               "ndcg@k": "二值相关 (IDCG = 把 |gold| 个 gold 排最前), 用 dcg = Σ 1/log2(rank+1)",
               "abstention": "正确 = 系统返回空 OR top1 分数 < 阈值; 其它情况记 0"},
           "cases": cases}
    pathlib.Path(a.out).write_text(json.dumps(out, ensure_ascii=False, indent=2))
    dist = collections.Counter(c["type"] for c in cases)
    print(f"语料 {len(ents)} 条 -> {len(cases)} 个 case")
    for k, v in dist.items(): print(f"  {k:16s} {v}")
    leaked = sum(1 for c in cases if c["type"] == "abstention" and "泄漏" in c["note"])
    print("弃权关键词泄漏:", leaked)

if __name__ == "__main__":
    main()
