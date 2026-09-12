# bench/lib/full_context.py — "笨基线": 不做检索, 把整个语料塞进上下文。
#
# 为什么必须有它 (方法论要求, 见 docs/memory-benchmark-report.md §5):
# 如果"全塞进去"就够了, 那么检索质量根本不重要 —— 这个 benchmark 就在测一个不存在的问题。
# 它给不出漂亮的分数差异, 但能给出**规模拐点**: 语料大到多少token 时检索才成为必需。
#
# 用法: python3 bench/lib/full_context.py [--corpus FILE] [--runs FILE ...]
import argparse, json, math, pathlib, sys

HERE = pathlib.Path(__file__).resolve().parents[2]


def estimate_tokens(text: str) -> int:
    """与 src/kernel/ranking.ts 的 estimateTokens 同口径: 中文 1 字 ≈ 1 token, 拉丁 4 字符 ≈ 1。"""
    cjk = sum(1 for ch in text if "\u3040" <= ch <= "\u30ff" or "\u3400" <= ch <= "\u4dbf"
              or "\u4e00" <= ch <= "\u9fff" or "\uf900" <= ch <= "\ufaff" or "\uac00" <= ch <= "\ud7af")
    other = len(text) - cjk
    return cjk + math.ceil(other / 4)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--corpus", default=str(HERE / ".tmp" / "bench" / "corpus.json"))
    args = ap.parse_args()

    entries = json.loads(pathlib.Path(args.corpus).read_text())["entries"]
    toks = sorted((estimate_tokens(e["content"]) + 8 for e in entries), reverse=True)
    total = sum(toks)
    n = len(entries)

    print("=== 全上下文基线 (不做检索) ===")
    print(f"语料: {n} 条, 合计 {total} tokens (含每条 8 token 框架开销)")
    print(f"平均每条 {total // max(1, n)} tokens, 最大一条 {toks[0] if toks else 0} tokens")
    print()
    print("按上下文预算, 能塞下多少条:")
    print(f"{'预算':>8s} {'可容纳条数':>10s} {'占语料':>8s} {'是否已够用':>12s}")
    for budget in (8000, 32000, 128000, 200000, 1000000):
        acc, cnt = 0, 0
        for t in toks:
            if acc + t > budget:
                break
            acc += t
            cnt += 1
        pct = cnt / n * 100 if n else 0
        verdict = "是 (无需检索)" if cnt >= n else f"否 (缺 {n - cnt} 条)"
        print(f"{budget:>8d} {cnt:>10d} {pct:>7.0f}% {verdict:>12s}")

    print()
    print("=== 规模拐点: 语料长到多少条时, 全塞进去不再可行 ===")
    avg = total / max(1, n)
    for budget in (8000, 32000, 128000, 200000):
        crossover = int(budget / avg) if avg else 0
        print(f"  预算 {budget:>7d} tokens → 约 {crossover:>6d} 条之后必须检索 (按当前平均 {avg:.0f} tokens/条)")

    print()
    print("=== 检索的代价/收益 ===")
    # 检索臂通常返回 ~10 条; 全上下文返回全部
    for k in (5, 10):
        retr = sum(toks[:k]) if len(toks) >= k else sum(toks)
        print(f"  检索 top-{k}: 约 {retr:>6d} tokens/查询   "
              f"全上下文: {total:>6d} tokens/查询   "
              f"省 {100 * (1 - retr / max(1, total)):.1f}%")
    print()
    print("读法: 省下的 token 是确定的, 损失的召回是概率性的。")
    print("      当语料小到全上下文也塞得下时, 检索的收益主要是省 token 与降延迟, 而不是'能不能答对'。")
    return 0


sys.exit(main())
