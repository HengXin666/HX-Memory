# bench/runners/mem0.py — 被测系统: mem0 (OSS, Apache-2.0), raw 与 infer 两种模式。
#
# 两条模式必须都跑: infer=True 是它的卖点 (LLM 抽取), infer=False 是"原样存"。
# 只跑一条会得出片面结论 —— 本项目的第一次比较就栽在这里 (把 infer 的评测伪影当成了真实差距)。
#
# 用法: python3 bench/runners/mem0.py [--infer] [--cases FILE] [--k N] [--out FILE]
# 依赖: pip install mem0ai ; 本地嵌入服务 (bge-small-zh) + LLM 代理
import argparse, json, os, pathlib, sys, time

# 必须在 import mem0 之前设置: 它在模块级读取, 后设无效。
os.environ["MEM0_TELEMETRY"] = "false"
os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")

HERE = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(HERE / "bench" / "lib"))

LLM_BASE = os.environ.get("HXMEM_LLM_BASE", "http://127.0.0.1:4398/v1")
EMBED_BASE = os.environ.get("HXMEM_EMBED_BASE", "http://127.0.0.1:4399/v1")
LLM_MODEL = os.environ.get("HXMEM_LLM_MODEL", "deepseek/deepseek-v4-flash")
EMBED_MODEL = os.environ.get("HXMEM_EMBED_MODEL", "bge-small-zh-v1.5")


def config_for(tag: str, key: str) -> dict:
    return {
        "llm": {"provider": "openai", "config": {
            "model": LLM_MODEL, "api_key": key, "openai_base_url": LLM_BASE,
            "temperature": 0.1, "max_tokens": 2000}},
        "embedder": {"provider": "openai", "config": {
            "model": EMBED_MODEL, "api_key": "dummy",
            "openai_base_url": EMBED_BASE, "embedding_dims": 512}},
        "vector_store": {"provider": "qdrant", "config": {
            "path": "/tmp/hxmem-mem0-" + tag, "collection_name": "hxmem",
            "embedding_model_dims": 512}},
        "history_db_path": "/tmp/hxmem-mem0-" + tag + ".db",
    }


def norm(s: str) -> str:
    return "".join(ch for ch in (s or "").lower() if ch.isalnum())


def make_resolver(corpus):
    by_text = {norm(e["content"]): e["id"] for e in corpus}
    by_prefix = {norm(e["content"])[:60]: e["id"] for e in corpus}

    def resolve(text, meta):
        if isinstance(meta, dict) and meta.get("src_id"):
            return meta["src_id"]
        n = norm(text)
        if n in by_text:
            return by_text[n]
        if n[:60] in by_prefix:
            return by_prefix[n[:60]]
        for key, mid in by_prefix.items():
            if len(key) > 30 and (key in n or (len(n) > 40 and n[:40] in key)):
                return mid
        return None
    return resolve


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--infer", action="store_true", help="开启 LLM 抽取 (默认关闭 = 原样存)")
    ap.add_argument("--corpus", default=str(HERE / ".tmp" / "bench" / "corpus.json"))
    ap.add_argument("--cases", default=str(HERE / ".tmp" / "bench" / "cases.json"))
    ap.add_argument("--k", type=int, default=10)
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    key = os.environ.get("HXAPI_API_KEY", "")
    if args.infer and not key:
        print("需要 HXAPI_API_KEY 才能跑 infer 模式", file=sys.stderr)
        return 1
    # raw 模式不会真的调 LLM, 但 mem0 仍会构造 OpenAI 客户端 —— 缺 key 直接抛。
    if not key:
        key = "dummy-for-raw-mode"

    from mem0 import Memory
    corpus = json.loads(pathlib.Path(args.corpus).read_text())["entries"]
    cases = json.loads(pathlib.Path(args.cases).read_text())["cases"]
    tag = "infer" if args.infer else "raw"

    m = Memory.from_config(config_for(tag, key))
    t0 = time.time()
    errors = 0
    for e in corpus:
        try:
            m.add([{"role": "user", "content": e["content"]}], user_id="hxmem",
                  metadata={"src_id": e["id"]}, infer=args.infer)
        except Exception as ex:
            errors += 1
            if errors <= 3:
                print("  add 失败:", type(ex).__name__, str(ex)[:120], file=sys.stderr)
    write_s = time.time() - t0

    # 默认 top_k=20 会静默截断, 必须显式给大值。
    stored = m.get_all(filters={"user_id": "hxmem"}, top_k=10000)
    items = stored.get("results", stored)

    resolve = make_resolver(corpus)
    runs, meta = {}, {}
    for c in cases:
        try:
            r = m.search(c["query"], filters={"user_id": "hxmem"}, top_k=args.k)
            hits = r.get("results", r) if isinstance(r, dict) else r
        except Exception:
            hits = []
        ids = [resolve(h.get("memory", ""), h.get("metadata") or {}) for h in (hits or [])]
        runs[c["id"]] = [i for i in ids if i]
        meta[c["id"]] = {"returned": len(hits or []), "top1Score": (hits or [{}])[0].get("score")}

    out = args.out or str(HERE / ".tmp" / "bench" / ("mem0-" + tag + "-runs.json"))
    pathlib.Path(out).parent.mkdir(parents=True, exist_ok=True)
    pathlib.Path(out).write_text(json.dumps(
        [{"variant": "mem0 " + tag, "k": args.k, "runs": runs, "meta": meta,
          "stored": len(items), "writeS": round(write_s), "errors": errors}],
        ensure_ascii=False, indent=2))
    print(f"mem0 {tag}: 语料 {len(corpus)} → 存储 {len(items)} 条, 写入 {write_s:.0f}s, 失败 {errors}")
    print("输出: " + out)
    return 0


sys.exit(main())
