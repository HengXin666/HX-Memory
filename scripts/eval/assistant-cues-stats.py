#!/usr/bin/env python3
"""scripts/eval/assistant-cues-stats.py — ASSISTANT-CUES.md 的全部数字。输入 assistant-cues-detect.ts 的输出, 输出 JSON。

前缀 = 下一条 assistant 消息第一个 text 块 strip 后的前 12 个字符。只列在阳性轮次里出现 >= 2 次的前缀。
阳性口径 (--truth):
  detect  现有 detect 判阳性 (neg == true), 所有用户原话都参与;
  human   人工标注 samples.jsonl 里 label ∈ {insult, correction, both} 为阳性, label == none 为阴性,
          只有 msg_id 对得上样本的用户原话参与, 对不上的计入 unmatched。
精确率 = 该前缀在阳性轮次出现次数 / 该前缀在全部配到首句轮次出现次数。召回率 = 前者 / 阳性配到首句的条数。
道歉开头 (APOLOGY, 用户 2026-11-01 指定的四个开头, 不增不减): 首句 strip 后以其中之一开头即算命中, 逐个与合计报阳性/阴性次数。
用法: python3 scripts/eval/assistant-cues-stats.py <dir>/detected.jsonl [--truth detect|human] [--samples tests/fixtures/eval/frustration/samples.jsonl]
"""
import argparse, json
from collections import Counter

APOLOGY = ["你说得对", "抱歉", "我的错", "你说错了"]
POS_LABELS = {"insult", "correction", "both"}

ap = argparse.ArgumentParser()
ap.add_argument("detected")
ap.add_argument("--truth", default="detect", choices=["detect", "human"])
ap.add_argument("--samples", default="tests/fixtures/eval/frustration/samples.jsonl")
a = ap.parse_args()
rows = [json.loads(l) for l in open(a.detected, encoding="utf8") if l.strip()]
meta = json.load(open(a.detected.replace("detected.jsonl", "pairs.jsonl") + ".meta.json", encoding="utf8"))
ss = meta["sessions"]
out = {
    "mode": meta.get("mode"), "truth": a.truth,
    "sessions_read": len(ss),
    "sessions_excluded_subagent": sum(s["delegated"] for s in ss),
    "sessions_excluded_by_descriptor": sum(s["has_subagent_descriptor"] for s in ss),
    "sessions_excluded_by_first_source_kind": sum((not s["has_subagent_descriptor"]) and s["first_user_message_source_kind"] != "user" for s in ss),
    "sessions_selected": sum(s["selected"] for s in ss),
    "selected_user_msgs_per_session": sorted([s["user_msgs"] for s in ss if s["selected"]], reverse=True),
    "user_msgs": len(rows),
    "detect_positive": sum(r["neg"] for r in rows),
}
if a.truth == "human":
    lab = {}
    for l in open(a.samples, encoding="utf8"):
        if l.strip():
            s = json.loads(l)
            lab[s["source"]["msg_id"]] = s["label"]
    out["labeled_samples_total"] = len(lab)
    matched = [r for r in rows if r["msg_id"] in lab]
    out["labeled_matched"] = len(matched)
    out["labeled_unmatched_in_these_sessions"] = len(rows) - len(matched)
    out["labeled_samples_not_found"] = len(set(lab) - {r["msg_id"] for r in rows})
    for r in matched:
        r["_pos"] = lab[r["msg_id"]] in POS_LABELS
    use = matched
else:
    for r in rows:
        r["_pos"] = bool(r["neg"])
    use = rows
pos = [r for r in use if r["_pos"]]
neg = [r for r in use if not r["_pos"]]
pt = [r for r in pos if r["first_text"]]
nt = [r for r in neg if r["first_text"]]
out |= {
    "positive_turns": len(pos), "positive_with_next_asst_msg": sum(r["asst_found"] for r in pos), "positive_with_first_text": len(pt),
    "negative_turns": len(neg), "negative_with_next_asst_msg": sum(r["asst_found"] for r in neg), "negative_with_first_text": len(nt),
}
out["base_rate"] = len(pt) / (len(pt) + len(nt)) if pt or nt else None
pre = lambda r: r["first_text"][:12]
cp, ca = Counter(pre(r) for r in pt), Counter(pre(r) for r in pt + nt)
out["prefixes_ge2_in_positive"] = [
    {"prefix": k, "count_positive": v, "share_of_positive_with_text": v / len(pt), "count_all_with_text": ca[k],
     "precision": v / ca[k], "recall": v / len(pt)}
    for k, v in cp.most_common() if v >= 2]
import math
def wilson(k, n, z=1.96):
    if n == 0:
        return None
    ph = k / n; d = 1 + z * z / n; c = ph + z * z / (2 * n); r = z * math.sqrt(ph * (1 - ph) / n + z * z / (4 * n * n))
    return [round(max(0, (c - r) / d), 4), round(min(1, (c + r) / d), 4)]
ap_rows = []
for p in APOLOGY + ["<any>"]:
    hit = (lambda r: any(r["first_text"].startswith(x) for x in APOLOGY)) if p == "<any>" else (lambda r, p=p: r["first_text"].startswith(p))
    hp, hn = sum(hit(r) for r in pt), sum(hit(r) for r in nt)
    ap_rows.append({"apology": p, "in_positive": hp, "in_negative": hn,
                    "precision": hp / (hp + hn) if hp + hn else None, "recall": hp / len(pt) if pt else None,
                    "precision_wilson95": wilson(hp, hp + hn), "recall_wilson95": wilson(hp, len(pt)),
                    "in_positive_missed_by_detect": sum(hit(r) and not r["neg"] for r in pt),
                    "in_negative_detect_hit": sum(hit(r) and r["neg"] for r in nt)})
# 需要多少条人工标注: 让道歉开头 (<any>) 的精确率和召回率 Wilson 95% 半宽都 <= 0.10 (正态近似 n >= 1.96^2 p(1-p) / 0.1^2),
# 按本样本的「命中率 / 阳性配到首句率」把所需命中数、阳性数折算回标注条数。
anyr = ap_rows[-1]
labeled = len(use)
if labeled and anyr["in_positive"] + anyr["in_negative"] and pt:
    pp, rr = anyr["precision"], anyr["recall"]
    need_hits = math.ceil(1.96 ** 2 * pp * (1 - pp) / 0.01)
    need_pos = math.ceil(1.96 ** 2 * rr * (1 - rr) / 0.01)
    hits_per_label = (anyr["in_positive"] + anyr["in_negative"]) / labeled
    pos_text_per_label = len(pt) / labeled
    out["labels_needed"] = {"half_width": 0.10, "need_cue_hits": need_hits, "need_positive_with_text": need_pos,
                            "cue_hits_per_label": hits_per_label, "positive_with_text_per_label": pos_text_per_label,
                            "labels_for_precision": math.ceil(need_hits / hits_per_label),
                            "labels_for_recall": math.ceil(need_pos / pos_text_per_label)}
out["apology_openers"] = ap_rows
out["all_positive_prefixes"] = cp.most_common()
out["all_negative_prefixes"] = Counter(pre(r) for r in nt).most_common()
out["positive_first_texts"] = [{"msg_id": r["msg_id"], "first_text_80": r["first_text"][:80]} for r in pt]
print(json.dumps(out, ensure_ascii=False, indent=1))
