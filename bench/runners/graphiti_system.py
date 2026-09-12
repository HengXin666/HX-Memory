# bench/runners/graphiti_system.py — 被测系统: Graphiti (Apache-2.0), 时序知识图谱。
#
# 架构与其他被测系统差异最大: 它把对话/文本抽成"实体 + 事实边", 边带 valid_at/invalid_at
# 双时态。检索返回的也是**边 (事实)** 而不是原文, 所以映射回源条目要靠事实文本与原文的重合。
#
# 用法: python3 bench/runners/graphiti_system.py [--k N] [--out FILE]
# 依赖: graphiti-core (见调研文档), 本地 LLM 代理 + 本地嵌入服务
import argparse, asyncio, json, os, pathlib, re, sys, time
from datetime import datetime

HERE = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(HERE / "bench" / "lib"))

# 本地代理会把 Authorization 原样转发给上游, 因此这里必须是**真实** key ——
# 假 key 会被上游拒成 401 (实测)。
os.environ.setdefault("SEMAPHORE_LIMIT", "3")
_KEY = os.environ.get("HXAPI_API_KEY", "")
if not _KEY:
    try:
        import yaml
        _KEY = yaml.safe_load(open(os.path.expanduser("~/.dsh/.credentials.yaml")))["refs"]["HXAPI_API_KEY"]
    except Exception:
        _KEY = ""
os.environ.setdefault("OPENAI_API_KEY", _KEY)

LLM_BASE = os.environ.get("HXMEM_LLM_BASE", "http://127.0.0.1:4398/v1")
EMBED_BASE = os.environ.get("HXMEM_EMBED_BASE", "http://127.0.0.1:4399/v1")


def norm(s: str) -> str:
    return "".join(ch for ch in (s or "").lower() if ch.isalnum())


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--k", type=int, default=10)
    ap.add_argument("--limit", type=int, default=0, help="只处理前 N 条语料 (调试用)")
    ap.add_argument("--corpus", default=str(HERE / ".tmp" / "bench" / "corpus.json"))
    ap.add_argument("--cases", default=str(HERE / ".tmp" / "bench" / "cases.json"))
    ap.add_argument("--out", default=str(HERE / ".tmp" / "bench" / "graphiti-runs.json"))
    args = ap.parse_args()

    from graphiti_core import Graphiti
    from graphiti_core.llm_client.openai_generic_client import OpenAIGenericClient
    from graphiti_core.llm_client.config import LLMConfig
    from graphiti_core.embedder.openai import OpenAIEmbedder, OpenAIEmbedderConfig
    from graphiti_core.driver.falkordb_driver import FalkorDriver
    from graphiti_core.cross_encoder.openai_reranker_client import OpenAIRerankerClient
    from graphiti_core.cross_encoder.client import CrossEncoderClient
    from redislite.async_falkordb_client import AsyncFalkorDB

    corpus = json.loads(pathlib.Path(args.corpus).read_text())["entries"]
    if args.limit:
        corpus = corpus[: args.limit]
    cases = json.loads(pathlib.Path(args.cases).read_text())["cases"]

    # structured_output_mode: 本地上游网关不支持 json_schema 类型的 response_format
    # (实测报 "This response_format type is unavailable now"), 退回 json_object。
    # 这正是调研文档里记的坑 (官方要求第三方 OpenAI 兼容端点用 OpenAIGenericClient)。
    llm = OpenAIGenericClient(config=LLMConfig(
        api_key=_KEY or "dummy", base_url=LLM_BASE, model="deepseek/deepseek-v4-flash",
        small_model="deepseek/deepseek-v4-flash", temperature=0.1, max_tokens=2000),
        structured_output_mode="json_object")
    embedder = OpenAIEmbedder(config=OpenAIEmbedderConfig(
        api_key="dummy", base_url=EMBED_BASE, embedding_model="bge-small-zh-v1.5",
        embedding_dim=512))

    async def run():
        db = "/tmp/hxmem-graphiti.db"
        for suffix in ("", ".rdb", ".aof"):
            try:
                os.remove(db + suffix)
            except OSError:
                pass
        client = AsyncFalkorDB(dbfilename=db)
        # Graphiti 构造时会自动建一个 OpenAI reranker; 不显式传就会去读 OPENAI_API_KEY
        # 并可能在缺 key 时直接抛 (实测)。这里显式给它同一个网关配置。
        reranker = OpenAIRerankerClient(config=LLMConfig(
            api_key=_KEY or "dummy", base_url=LLM_BASE, model="deepseek/deepseek-v4-flash"))
        g = Graphiti(graph_driver=FalkorDriver(falkor_db=client), llm_client=llm,
                     embedder=embedder, cross_encoder=reranker)
        await g.build_indices_and_constraints()

        t0 = time.time()
        added, failures = 0, []
        # episode uuid → 源条目 id: 这是**准确**的血缘映射。
        # 不这么做就只能拿事实文本跟原文做模糊比对 (Graphiti 返回的是改写后的事实, 不是原文),
        # 会把"抽取改写"误判成"没召回"。
        uuid_of_source: dict[str, str] = {}
        for e in corpus:
            try:
                # reference_time 需要 datetime (传 ISO 字符串会报 'str' has no attribute 'isoformat')
                rt = datetime.fromisoformat(e["assertedAt"].replace("Z", "+00:00"))
                ok = await g.add_episode(name=e["id"], episode_body=e["content"],
                                         source_description="hx-memory", reference_time=rt,
                                         group_id="hxmem")
                uuid_of_source[str(ok.episode.uuid)] = e["id"]
                added += 1
            except Exception as ex:
                failures.append(type(ex).__name__ + ": " + str(ex)[:120])
                if len(failures) <= 3:
                    print("add_episode 失败:", failures[-1], file=sys.stderr)
        write_s = time.time() - t0

        runs, meta = {}, {}
        for c in cases:
            try:
                edges = await g.search(c["query"], num_results=args.k)
            except Exception as ex:
                edges = []
                meta[c["id"]] = {"error": type(ex).__name__ + ": " + str(ex)[:120]}
            ids: list[str] = []
            for edge in edges or []:
                for ep_uuid in (getattr(edge, "episodes", None) or []):
                    mid = uuid_of_source.get(str(ep_uuid))
                    if mid and mid not in ids:
                        ids.append(mid)
            runs[c["id"]] = ids[: args.k]
            meta.setdefault(c["id"], {})["returned"] = len(ids)
        return added, write_s, runs, meta, failures

    added, write_s, runs, meta, failures = asyncio.run(run())
    pathlib.Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    pathlib.Path(args.out).write_text(json.dumps(
        [{"variant": "graphiti", "k": args.k, "runs": runs, "meta": meta,
          "stored": added, "writeS": round(write_s), "errors": failures[:10]}],
        ensure_ascii=False, indent=2))
    hit = sum(1 for v in runs.values() if v)
    print(f"graphiti: 语料 {len(corpus)} → episode {added}, 写入 {write_s:.0f}s, "
          f"失败 {len(failures)}, 有结果的 case {hit}/{len(cases)}")
    print("输出: " + args.out)
    return 0


sys.exit(main())
