# bench/lib/paraphrase.py — 用真实 LLM 生成**同义改写** case, 补齐词面探针测不到的语义层。
#
# 为什么必须补: 现有 case 全是字面探针 (唯一子串/共享词面), 结构上偏爱 FTS ——
# 于是"语义通道无用"这个结论根本无法从它得出。要测语义, 查询必须与原文**字面不重合**。
#
# 做法: 让 LLM 读一条记忆, 生成一个"看字面完全不像、但意思相同"的自然提问;
# 然后机器校验: 生成的查询与原文的字符 bigram 重合度必须低于阈值 (否则丢弃, 不算真正的改写)。
#
# 用法: python3 bench/lib/paraphrase.py [--n 60] [--out FILE]
import json, os, pathlib, random, re, sys, urllib.request, yaml

HERE = pathlib.Path(__file__).resolve().parents[2]
KEY = yaml.safe_load(open(os.path.expanduser("~/.dsh/.credentials.yaml")))["refs"]["HXAPI_API_KEY"]
LLM = "http://127.0.0.1:4398/v1/chat/completions"

PROMPT = """你在为记忆检索系统造测试用例。

给你一条记忆原文, 请写一个**自然的提问**: 提问者想知道这条记忆里的信息,
但**不能复用原文里的罕见词/术语/数字**, 要用日常生活中更常见的说法来问。

要求:
- 只输出提问本身, 一行, 不要引号不要解释;
- 与原文的字面重合要尽量低 (尤其是专有名词与技术术语, 换成通俗表达);
- 意思必须与原文一致, 不能问偏。

记忆原文:
<memory>
{{memory}}
</memory>"""


def ask(memory: str, model: str = "deepseek/deepseek-v4-flash") -> str:
    body = {"model": model, "temperature": 0.7,
            "messages": [{"role": "user", "content": PROMPT.replace("{{memory}}", memory[:1200])}],
            "max_tokens": 200}
    req = urllib.request.Request(LLM, data=json.dumps(body).encode(),
                                headers={"content-type": "application/json", "authorization": "Bearer " + KEY})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read())["choices"][0]["message"]["content"].strip()


def bigrams(s: str) -> set[str]:
    n = re.sub(r"[\s\p{P}\p{S}]+", "", s.lower()) if False else re.sub(r"[^0-9A-Za-z\u4e00-\u9fff]+", "", s.lower())
    return {n[i:i + 2] for i in range(len(n) - 1)}


def overlap(a: str, b: str) -> float:
    x, y = bigrams(a), bigrams(b)
    if not x or not y:
        return 0.0
    return len(x & y) / len(x)


def main() -> int:
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=60)
    ap.add_argument("--max-overlap", type=float, default=0.35)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--out", default=str(HERE / ".tmp" / "bench" / "cases-paraphrase.json"))
    args = ap.parse_args()

    corpus = json.loads((HERE / ".tmp" / "bench" / "corpus.json").read_text())["entries"]
    # 只取足够长的条目 (太短的没东西可改写)
    pool = [e for e in corpus if len(e["content"]) >= 80]
    random.Random(args.seed).shuffle(pool)

    cases, rejected = [], 0
    for e in pool:
        if len(cases) >= args.n:
            break
        try:
            q = ask(e["content"])
        except Exception as ex:
            print("  LLM 失败:", type(ex).__name__, str(ex)[:80], file=sys.stderr)
            continue
        q = q.strip().split("\n")[0].strip().strip('"').strip()
        if len(q) < 4:
            rejected += 1
            continue
        ov = overlap(q, e["content"])
        if ov > args.max_overlap:
            rejected += 1  # 与原文太像, 不算同义改写
            continue
        cases.append({
            "id": "c-paraphrase-" + str(len(cases)).zfill(4),
            "type": "paraphrase",
            "query": q,
            "expect": [e["id"]],
            "note": "LLM 同义改写, 与原文 bigram 重合 %.2f (阈值 %.2f)" % (ov, args.max_overlap),
        })

    pathlib.Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    pathlib.Path(args.out).write_text(json.dumps(
        {"schema": "hxmem-cases-paraphrase/1", "cases": cases}, ensure_ascii=False, indent=2))
    print("生成 paraphrase case: " + str(len(cases)) + " 条 (拒绝 " + str(rejected) + " 条, 因与原文太像或太短)")
    if cases:
        print("平均 bigram 重合: %.2f" % (sum(float(c["note"].split("重合 ")[1].split(" ")[0]) for c in cases) / len(cases)))
    print("输出: " + args.out)
    return 0


sys.exit(main())
