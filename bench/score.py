# bench/score.py — 统一打分器: 所有系统同一口径, 输出对比表 + 配对显著性。
#
# 为什么必须统一: 各自口径会让结论直接翻转。本项目踩过两次 ——
# ① HX-Memory 侧把 abstention 的空 gold 按 rr=0 计入 MRR, mem0 侧却排除, 同一批 case 两套算法;
# ② mem0 的 LLM 抽取会把一条源条目拆成多条, 同一 id 在 top-k 里重复出现, nDCG 因此重复计分 (dcg>idcg)。
# 这里统一: 检索指标只在有 gold 的 case 上算; 同一源条目去重; 弃权单独统计。
#
# 用法: python3 bench/score.py --runs FILE [--runs FILE ...] [--cases FILE]
import argparse, json, math, pathlib, random, sys

HERE = pathlib.Path(__file__).resolve().parents[1]


def dedupe(ranked):
    """同一源条目可能因抽取被拆成多条而重复出现; 不去重会让 nDCG 重复计分。"""
    seen, out = set(), []
    for x in ranked:
        if x in seen:
            continue
        seen.add(x)
        out.append(x)
    return out


def recall_at(ranked, gold, k):
    return len(set(ranked[:k]) & gold) / len(gold) if gold else 0.0


def rr(ranked, gold):
    for i, x in enumerate(ranked):
        if x in gold:
            return 1.0 / (i + 1)
    return 0.0


def ndcg_at(ranked, gold, k):
    dcg = sum(1.0 / math.log2(i + 2) for i, x in enumerate(ranked[:k]) if x in gold)
    idcg = sum(1.0 / math.log2(i + 2) for i in range(min(k, len(gold))))
    return dcg / idcg if idcg else 0.0


def score_runs(runs, cases, k):
    per = {}
    for c in cases:
        gold = set(c["expect"])
        if not gold:
            continue  # 弃权类单独统计
        ranked = dedupe(runs.get(c["id"], []))
        per[c["id"]] = {
            "r1": recall_at(ranked, gold, 1), "r5": recall_at(ranked, gold, 5),
            "r10": recall_at(ranked, gold, k), "rr": rr(ranked, gold),
            "ndcg10": ndcg_at(ranked, gold, k), "type": c["type"],
        }
    agg = {m: (sum(v[m] for v in per.values()) / len(per) if per else 0.0)
           for m in ("r1", "r5", "r10", "rr", "ndcg10")}
    by_type = {}
    for v in per.values():
        by_type.setdefault(v["type"], []).append(v)
    by_type = {t: {m: sum(x[m] for x in vs) / len(vs) for m in ("r1", "r5", "r10", "rr")}
               for t, vs in by_type.items()}
    return {"n": len(per), "agg": agg, "by_type": by_type, "per": per}


def paired_bootstrap(a, b, metric="r10", n_boot=10000, seed=42):
    ids = sorted(set(a["per"]) & set(b["per"]))
    diffs = [a["per"][i][metric] - b["per"][i][metric] for i in ids]
    if not diffs:
        return None
    rnd = random.Random(seed)
    boots = sorted(sum(diffs[rnd.randrange(len(diffs))] for _ in diffs) / len(diffs)
                   for _ in range(n_boot))
    lo, hi = boots[int(0.025 * n_boot)], boots[int(0.975 * n_boot)]
    mean = sum(diffs) / len(diffs)
    p = 2 * min(sum(1 for x in boots if x <= 0) / n_boot,
                sum(1 for x in boots if x >= 0) / n_boot)
    return {"mean": mean, "lo": lo, "hi": hi, "p": min(1.0, p), "n": len(diffs)}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", action="append", required=True)
    ap.add_argument("--cases", default=str(HERE / ".tmp" / "bench" / "cases.json"))
    ap.add_argument("--k", type=int, default=10)
    ap.add_argument("--json", default=None, help="把结果写成 JSON")
    args = ap.parse_args()

    cases = json.loads(pathlib.Path(args.cases).read_text())["cases"]
    retrieval = [c for c in cases if c["expect"]]
    abstain = [c for c in cases if not c["expect"]]

    rows = []
    for path in args.runs:
        for r in json.loads(pathlib.Path(path).read_text()):
            s = score_runs(r["runs"], cases, r["k"] if "k" in r else args.k)
            rows.append({"label": r["variant"], "k": r.get("k", args.k),
                         "stored": r.get("stored"), "writeS": r.get("writeS"), **s})

    print(f"=== 统一口径对比 ({len(retrieval)} 检索 case / {len(abstain)} 弃权 case, k={args.k}) ===")
    print("说明: 检索指标只在有 gold 的 case 上算; 同一源条目重复命中去重; 弃权单独统计。")
    print()
    print(f"{'系统':34s} {'R@1':>7s} {'R@5':>7s} {'R@10':>7s} {'MRR':>7s} {'nDCG@10':>8s}")
    for r in rows:
        a = r["agg"]
        print(f"{r['label']:34s} {a['r1']:7.3f} {a['r5']:7.3f} {a['r10']:7.3f} {a['rr']:7.3f} {a['ndcg10']:8.3f}")

    print()
    print("按 case 类型分解 (recall@10):")
    types = sorted({t for r in rows for t in r["by_type"]})
    print(f"{'系统':34s} " + " ".join(f"{t:>16s}" for t in types))
    for r in rows:
        print(f"{r['label']:34s} " + " ".join(f"{r['by_type'].get(t, {}).get('r10', 0):16.3f}" for t in types))

    if len(rows) >= 2:
        print()
        print("配对 bootstrap (同一批 case, recall@10; CI 跨 0 = 不显著):")
        base = rows[-1]
        for r in rows[:-1]:
            pb = paired_bootstrap(r, base, "r10")
            if not pb:
                continue
            sig = "显著" if (pb["lo"] > 0 or pb["hi"] < 0) else "不显著"
            print(f"  {r['label'][:30]:32s} vs {base['label'][:22]:24s} "
                  f"Δ={pb['mean']:+.3f} CI=[{pb['lo']:+.3f},{pb['hi']:+.3f}] p≈{pb['p']:.3f} {sig}")

    print()
    print("弃权类 (期望无相关记忆):")
    for path in args.runs:
        for r in json.loads(pathlib.Path(path).read_text()):
            meta = r.get("meta", {})
            returns = [meta.get(c["id"], {}).get("returned") for c in abstain if c["id"] in meta]
            if returns:
                print(f"  {r['variant']:34s} 返回条数 {returns}")

    if args.json:
        pathlib.Path(args.json).write_text(json.dumps(
            [{k: v for k, v in r.items() if k != "per"} for r in rows], ensure_ascii=False, indent=2))
        print("\n→ " + args.json)
    return 0


sys.exit(main())
