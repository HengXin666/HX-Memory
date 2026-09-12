# bench/lib/cost_quality.py — 每个系统的"质量 vs token 成本"前沿。
#
# 动机: 全上下文基线实测只需 16.5k tokens (80 条语料), 也就是说在当前规模下
# 检索的**必要性**来自成本与延迟, 不是"能不能答对"。既然如此, 只报质量是不完整的 ——
# 必须同时报每次查询实际注入多少 token。
#
# 用法: python3 bench/lib/cost_quality.py --runs FILE [--runs FILE ...]
import argparse, json, math, pathlib, sys

HERE = pathlib.Path(__file__).resolve().parents[2]


def estimate_tokens(text: str) -> int:
    cjk = sum(1 for ch in text if "\u3040" <= ch <= "\u30ff" or "\u3400" <= ch <= "\u4dbf"
              or "\u4e00" <= ch <= "\u9fff" or "\uf900" <= ch <= "\ufaff" or "\uac00" <= ch <= "\ud7af")
    return cjk + math.ceil((len(text) - cjk) / 4)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", action="append", required=True)
    ap.add_argument("--corpus", default=str(HERE / ".tmp" / "bench" / "corpus.json"))
    ap.add_argument("--cases", default=str(HERE / ".tmp" / "bench" / "cases.json"))
    args = ap.parse_args()

    corpus = {e["id"]: e for e in json.loads(pathlib.Path(args.corpus).read_text())["entries"]}
    cases = {c["id"]: c for c in json.loads(pathlib.Path(args.cases).read_text())["cases"]}
    tok = {i: estimate_tokens(e["content"]) + 8 for i, e in corpus.items()}
    full_total = sum(tok.values())

    print(f"全上下文基线: 每次查询 {full_total} tokens (把 {len(corpus)} 条全塞进去)")
    print()
    print(f"{'系统':34s} {'平均返回条数':>12s} {'平均 tokens':>12s} {'占全上下文':>10s} {'R@10':>7s} {'token效率':>10s}")
    for path in args.runs:
        for r in json.loads(pathlib.Path(path).read_text()):
            runs = r["runs"]
            toks, counts = [], []
            for cid, ids in runs.items():
                if cid not in cases or not cases[cid]["expect"]:
                    continue  # 弃权类不计
                t = sum(tok.get(i, 0) for i in ids)
                toks.append(t)
                counts.append(len(ids))
            if not toks:
                continue
            avg_t = sum(toks) / len(toks)
            avg_n = sum(counts) / len(counts)
            # R@10 从 meta/score 复用不了, 这里只报成本; 质量列由 score.py 给
            print(f"{r['variant']:34s} {avg_n:12.1f} {avg_t:12.0f} {100*avg_t/full_total:9.1f}% "
                  f"{'':>7s} {100*(1-avg_t/full_total):9.1f}%")
    print()
    print("读法: 质量列见 score.py 的表。把两张表并排看才能回答")
    print("      '这个系统多花/少花了多少 token, 换来了多少质量' ——")
    print("      在语料小到全塞得下时, token 效率本身就是主要卖点。")
    return 0


sys.exit(main())
