#!/usr/bin/env python3
"""eval_kit.py - retrieval / extraction metrics + paired significance tests for
head-to-head memory-system comparison. No third-party deps (stdlib only)."""
from __future__ import annotations
import math, random, statistics
from typing import Sequence, Callable

# ---------------- retrieval metrics (binary relevance) ----------------

def recall_at_k(ranked: Sequence[str], relevant: set[str], k: int) -> float:
    """|retrieved[:k] AND relevant| / |relevant|. Empty relevant -> 1.0 by convention."""
    if not relevant:
        return 1.0
    return len(set(ranked[:k]) & relevant) / len(relevant)

def reciprocal_rank(ranked: Sequence[str], relevant: set[str]) -> float:
    """1/rank of first relevant item; 0 if none."""
    for i, d in enumerate(ranked, 1):
        if d in relevant:
            return 1.0 / i
    return 0.0

def dcg(gains: Sequence[float]) -> float:
    return sum(g / math.log2(i + 2) for i, g in enumerate(gains))  # rank i (0-based) -> log2(i+2)

def ndcg_at_k(ranked: Sequence[str], relevant: set[str], k: int, gains: dict[str,float] | None = None) -> float:
    """nDCG@k; binary relevance unless graded gains given. IDCG = ideal ordering of the
    relevant items actually available (<=k of them)."""
    seen, g = set(), []
    for d in ranked[:k]:
        if d in seen:
            continue
        seen.add(d)
        g.append((gains or {}).get(d, 1.0) if d in relevant else 0.0)
    d = dcg(g)
    ideal_gains = sorted([(gains or {}).get(x, 1.0) for x in relevant], reverse=True)[:k]
    i = dcg(ideal_gains)
    return d / i if i > 0 else (1.0 if not relevant else 0.0)

def evaluate_runs(runs: dict[str, list[str]], cases: dict[str, set[str]], ks=(1,5,10)) -> dict:
    """runs: case_id -> ranked doc ids ; cases: case_id -> set of relevant ids."""
    out = {}
    for k in ks:
        out[f"recall@{k}"] = statistics.mean(recall_at_k(runs[c], cases[c], k) for c in cases)
        out[f"ndcg@{k}"]   = statistics.mean(ndcg_at_k(runs[c], cases[c], k) for c in cases)
    out["mrr"] = statistics.mean(reciprocal_rank(runs[c], cases[c]) for c in cases)
    return out

# ---------------- extraction metrics ----------------

def prf(pred: set, gold: set) -> tuple[float,float,float]:
    """Set-valued field extraction: exact string match per element."""
    tp = len(pred & gold)
    p = tp / len(pred) if pred else (1.0 if not gold else 0.0)
    r = tp / len(gold) if gold else 1.0
    f = 2*p*r/(p+r) if (p+r) else 0.0
    return p, r, f

def micro_f1(pairs: Sequence[tuple[set,set]]) -> dict:
    tp = fp = fn = 0
    for pred, gold in pairs:
        tp += len(pred & gold); fp += len(pred - gold); fn += len(gold - pred)
    p = tp/(tp+fp) if tp+fp else 0.0
    r = tp/(tp+fn) if tp+fn else 0.0
    return {"precision": p, "recall": r, "f1": 2*p*r/(p+r) if p+r else 0.0,
            "tp": tp, "fp": fp, "fn": fn}

def field_fill_rate(preds: Sequence[dict], fields: Sequence[str]) -> dict:
    """Structured field fill rate + exact-match accuracy per field."""
    n = len(preds)
    return {f: (sum(1 for p in preds if p.get(f) not in (None, "", [], {})) / n) for f in fields}

def atomicity_score(texts: Sequence[str], split_fn: Callable[[str], list[str]]) -> float:
    """Fraction of extracted 'memories' that carry exactly ONE atomic claim.
    split_fn is your sentence/clause splitter (e.g. regex on [.;;] + conjunctions)."""
    if not texts: return 0.0
    return sum(1 for t in texts if len([s for s in split_fn(t) if s.strip()]) <= 1) / len(texts)

# ---------------- significance ----------------

def bootstrap_ci(xs: Sequence[float], n_boot=10000, alpha=0.05, seed=42) -> tuple[float,float,float]:
    rnd = random.Random(seed); n = len(xs); means = []
    for _ in range(n_boot):
        means.append(sum(xs[rnd.randrange(n)] for _ in range(n)) / n)
    means.sort()
    return (statistics.mean(xs), means[int(alpha/2*n_boot)], means[int((1-alpha/2)*n_boot)])

def paired_bootstrap(a: Sequence[float], b: Sequence[float], n_boot=10000, seed=42) -> dict:
    """Two-sided paired bootstrap (Sakai/TREC style): resample CASES with replacement,
    recompute mean difference. p = P(sign flips). Returns delta, 95% CI, p."""
    assert len(a) == len(b)
    rnd = random.Random(seed); n = len(a); d0 = statistics.mean(a) - statistics.mean(b); diffs = []
    idx = list(range(n))
    for _ in range(n_boot):
        s = [idx[rnd.randrange(n)] for _ in range(n)]
        diffs.append(sum(a[i] for i in s)/n - sum(b[i] for i in s)/n)
    lo, hi = sorted(diffs)[int(.025*n_boot)], sorted(diffs)[int(.975*n_boot)]
    p = 2*min(sum(1 for d in diffs if d <= 0)/n_boot, sum(1 for d in diffs if d >= 0)/n_boot)
    return {"delta": d0, "ci95": (lo, hi), "p_value": min(1.0, p), "n": n}

def mcnemar(a_correct: Sequence[bool], b_correct: Sequence[bool]) -> dict:
    """Exact-ish McNemar for paired binary outcomes (no scipy): uses binomial test."""
    b01 = sum(1 for x, y in zip(a_correct, b_correct) if not x and y)   # B wins
    b10 = sum(1 for x, y in zip(a_correct, b_correct) if x and not y)   # A wins
    n = b01 + b10
    if n == 0: return {"b01": b01, "b10": b10, "p_value": 1.0}
    # two-sided exact binomial p
    k = min(b01, b10)
    p = sum(math.comb(n, i) for i in range(0, k+1)) / (2**n) * 2
    return {"b01": b01, "b10": b10, "p_value": min(1.0, p)}

def required_n(effect: float, alpha=0.05, power=0.8) -> int:
    """Rough per-arm n for a paired comparison on a proportion difference.
    n ~ (z_{a/2}+z_b)^2 * p(1-p) / effect^2 ; p(1-p)<=0.25 worst case."""
    z_a, z_b = 1.959964, 0.8416212
    return math.ceil((z_a + z_b)**2 * 0.25 / (effect**2))

if __name__ == "__main__":
    cases = {f"q{i}": {f"d{i}"} for i in range(200)}
    A = {c: [cases[c].copy().pop()] + [f"x{i}" for i in range(9)] for i, c in enumerate(cases)}
    # system B slightly worse: pushes the gold to rank 3
    B = {}
    for i, c in enumerate(cases):
        gold = list(cases[c])[0]
        B[c] = [f"x{i}", f"y{i}", gold] + [f"z{i}" for _ in range(7)]
    ra, rb = evaluate_runs(A, cases), evaluate_runs(B, cases)
    print("A:", {k: round(v,4) for k,v in ra.items()})
    print("B:", {k: round(v,4) for k,v in rb.items()})
    a_rr = [reciprocal_rank(A[c], cases[c]) for c in cases]
    b_rr = [reciprocal_rank(B[c], cases[c]) for c in cases]
    print("paired bootstrap MRR:", paired_bootstrap(a_rr, b_rr))
    print("McNemar recall@1 :", mcnemar([recall_at_k(A[c],cases[c],1) for c in cases],
                                        [recall_at_k(B[c],cases[c],1) for c in cases]))
    print("bootstrap CI recall@10 A:", tuple(round(x,4) for x in bootstrap_ci([recall_at_k(A[c],cases[c],10) for c in cases])))
    print("micro_f1:", micro_f1([({"a","b"}, {"a","c"})]))
    print("n needed for +5pt:", required_n(0.05), " (+10pt):", required_n(0.10))
