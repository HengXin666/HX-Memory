#!/usr/bin/env python3
"""scripts/eval/kb-corpus-census.py — 清点博客语料: 全部 .md/.mdx 与 walkMarkdown (K3 口径) 看得见的差在哪。

walkMarkdown (src/app/kb-sync.ts) 跳过任何以 . 开头的目录或文件, 以及 node_modules; 只收 .md。
本脚本按同一规则把「看不见的」按原因分组, 方便核对 K3 分母。

用法: python3 scripts/eval/kb-corpus-census.py --src <博客根>
退出码: 0 清点完成; 2 参数错误。
"""
import json, os, sys

def main(argv):
    src = argv[argv.index("--src") + 1] if "--src" in argv else None
    if not src or not os.path.isdir(src):
        print("usage: kb-corpus-census.py --src <blog root>", file=sys.stderr); return 2
    allf = []
    for d in ("blog", "ai-docs", "docs"):
        for root, dirs, files in os.walk(os.path.join(src, d)):
            dirs[:] = [x for x in dirs if x not in ("node_modules", "build")]
            for f in files:
                if f.endswith((".md", ".mdx")):
                    allf.append(os.path.relpath(os.path.join(root, f), src).replace(os.sep, "/"))
    parts = lambda p: p.split("/")
    visible = [p for p in allf if p.endswith(".md") and not any(s.startswith(".") for s in parts(p))]
    hidden = [p for p in allf if any(s.startswith(".") for s in parts(p))]
    staging = [p for p in hidden if p.startswith("ai-docs/.hx-staging/")]
    dotfiles = [p for p in hidden if p not in staging and parts(p)[-1].startswith(".") and not any(s.startswith(".") for s in parts(p)[:-1])]
    other_hidden = [p for p in hidden if p not in staging and p not in dotfiles]
    by_name = {}
    for p in dotfiles: by_name[parts(p)[-1]] = by_name.get(parts(p)[-1], 0) + 1
    tiny = [p for p in visible if os.path.getsize(os.path.join(src, p)) < 50]
    print(json.dumps({
        "all_md_mdx": len(allf), "mdx": sum(p.endswith(".mdx") for p in allf),
        "walkMarkdown_visible": len(visible),
        "visible_by_dir": {d: sum(p.startswith(d + "/") for p in visible) for d in ("blog", "ai-docs", "docs")},
        "hidden_total": len(hidden),
        "hidden_under_ai-docs/.hx-staging": len(staging),
        "hidden_under_.hark-bak": sum("/.hark-bak/" in p for p in hidden),
        "hidden_dotfiles_outside_staging": len(dotfiles), "hidden_dotfiles_by_name": by_name,
        "hidden_other": other_hidden,
        "visible_tiny_lt50B": tiny,
    }, ensure_ascii=False, indent=1))
    return 0

if __name__ == "__main__":
    sys.exit(main(sys.argv))
