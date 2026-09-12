# bench/runners/basic_memory.py — 被测系统: Basic Memory (AGPL-3.0), 通过它的 CLI 检索。
#
# 为什么用 markdown 导入而不是 memory-json: 本骨架的语料是"一段段经验文本", 与 Basic Memory
# 的 note 形态同构; memory-json 面向 entity/relation 结构, 用它会把语料改写后再比较, 不公平。
#
# 用法: python3 bench/runners/basic_memory.py [--hybrid|--vector] [--cases FILE] [--k N] [--out FILE]
# 依赖: uv tool install basic-memory (或装进 venv); 中文语料建议配本地 bge 嵌入
import argparse, json, os, pathlib, re, shutil, subprocess, sys, tempfile

HERE = pathlib.Path(__file__).resolve().parents[2]
BM = os.environ.get("HXMEM_BM_BIN", "basic-memory")


def run_bm(args, cwd=None, env=None):
    return subprocess.run([BM, *args], capture_output=True, text=True, cwd=cwd, env=env, timeout=600)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["text", "hybrid", "vector"], default="text")
    ap.add_argument("--corpus", default=str(HERE / ".tmp" / "bench" / "corpus.json"))
    ap.add_argument("--cases", default=str(HERE / ".tmp" / "bench" / "cases.json"))
    ap.add_argument("--k", type=int, default=10)
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    corpus = json.loads(pathlib.Path(args.corpus).read_text())["entries"]
    cases = json.loads(pathlib.Path(args.cases).read_text())["cases"]

    project_dir = tempfile.mkdtemp(prefix="hxmem-bm-")
    env = dict(os.environ)
    # 每个项目一个独立 home, 避免污染用户真实的 basic-memory 数据
    env["BASIC_MEMORY_HOME"] = project_dir
    env.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
    env.setdefault("HF_HUB_DISABLE_XET", "1")

    # 1) 建项目 (目录即知识库)
    #
    # 项目名必须每次唯一: basic-memory 的项目注册表是**全局持久**的 (在 ~/.basic-memory/config.json),
    # 且项目名是主键 —— 复用同名项目会静默指向旧路径 (实测: 一次运行后所有检索都返回空,
    # 因为 search-notes 查的是旧目录)。
    notes = pathlib.Path(project_dir) / "notes"
    notes.mkdir(parents=True, exist_ok=True)
    project = "hxmem-" + pathlib.Path(project_dir).name.split("-")[-1]
    r = run_bm(["project", "add", project, str(notes)], env=env)
    if r.returncode != 0:
        print("project add 失败:", (r.stdout + r.stderr)[:400], file=sys.stderr)

    # 2) 一条记忆 = 一个 note; 文件名带源 id 以便把结果映射回 gold
    for e in corpus:
        slug = re.sub(r"[^A-Za-z0-9_-]", "", e["id"])[:40]
        path = notes / (slug + ".md")
        fm = ["---", "title: " + slug, "type: note"]
        if e.get("tags"):
            fm.append("tags: [" + ", ".join(json.dumps(t) for t in e["tags"]) + "]")
        fm.append("---")
        path.write_text("\n".join(fm) + "\n\n" + e["content"] + "\n", encoding="utf-8")

    # 3) 建索引 (reindex 把文件同步进库; 失败不致命, 搜索时也会自建)
    rr = run_bm(["reindex"], env=env)
    if rr.returncode != 0:
        print("reindex 警告:", (rr.stdout + rr.stderr)[:200], file=sys.stderr)

    # slug → 源 id: 一个 note 一个 slug, 检索结果里的 file_path 就是 slug.md
    slug_of = {e["id"]: re.sub(r"[^A-Za-z0-9_-]", "", e["id"])[:40] for e in corpus}
    id_of_slug = {v: k for k, v in slug_of.items()}

    # search-notes 的 --project 未出现在 --help 里, 但必须显式给 ——
    # 否则它查 default_project (用户的 main), 结果恒为空。
    runs, meta = {}, {}
    for c in cases:
        cmd = ["tool", "search-notes", c["query"], "--project", project, "--page-size", str(args.k)]
        if args.mode == "hybrid":
            cmd.append("--hybrid")
        elif args.mode == "vector":
            cmd.append("--vector")
        out = run_bm(cmd, env=env)
        text = out.stdout + out.stderr
        ids: list[str] = []
        try:
            payload = json.loads(text[text.index("{"): text.rindex("}") + 1])
            for item in payload.get("results", []):
                fp = str(item.get("file_path") or "")
                slug = pathlib.Path(fp).stem if fp else str(item.get("entity") or "").split("/")[-1]
                mid = id_of_slug.get(slug)
                if mid and mid not in ids:
                    ids.append(mid)
        except Exception:
            meta.setdefault(c["id"], {})["parseError"] = text[:200]
        runs[c["id"]] = ids[: args.k]
        meta.setdefault(c["id"], {})["returned"] = len(ids)
        meta[c["id"]]["scores"] = [
            round(x.get("score", 0), 4) for x in (payload.get("results", []) if "payload" in dir() else [])
        ][: args.k]

    out_path = args.out or str(HERE / ".tmp" / "bench" / ("bm-" + args.mode + "-runs.json"))
    pathlib.Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    pathlib.Path(out_path).write_text(json.dumps(
        [{"variant": "basic-memory (" + args.mode + ")", "k": args.k, "runs": runs, "meta": meta}],
        ensure_ascii=False, indent=2))
    hit = sum(1 for v in runs.values() if v)
    print(f"basic-memory {args.mode}: {len(cases)} case, 有结果的 {hit} 个")
    print("输出: " + out_path)
    shutil.rmtree(project_dir, ignore_errors=True)
    return 0


sys.exit(main())
