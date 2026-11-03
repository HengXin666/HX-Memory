"""无偏评测集 第 4 步: 由 judged-lex.cut.jsonl 产出 cases.jsonl + 指标 (只读 src/; 不筛 case: 规则 C1-C3 机械执行, 按 qid 顺序全收)。
C1 判官 standalone=true; C2 至少 1 条得分 2 的合格条目 (gold = 全部 2 分条目); C3 无 error。
用法: python3 build_cases.py  → tests/fixtures/eval/unbiased/cases.jsonl + .tmp/unbiased/metrics-lex.json"""
import json, re, random, math, sys
sys.path.insert(0, 'tests/fixtures/eval/unbiased/tools')
corpus = {e['id']: e for e in json.load(open('.tmp/bench/corpus-r2.json'))['entries']}
meta = json.load(open('.tmp/unbiased/meta.json'))
Q = {json.loads(l)['qid']: json.loads(l) for l in open('.tmp/unbiased/qpool.jsonl')}
runs = {r['qid']: r for r in json.load(open('.tmp/unbiased/runs-lex.json'))}
J = [json.loads(l) for l in open('.tmp/unbiased/judged-lex.cut.jsonl')]
J = sorted({j['qid']: j for j in J}.values(), key=lambda j: j['qid'])
# 复用 judge_lex 的 bm25/elig (不调用判官)
src = open('tests/fixtures/eval/unbiased/tools/judge_lex.py').read()
ns = {'corpus': corpus, 'meta': meta}
exec('import re,math\nfrom collections import Counter\n' + src[src.index('def bg(t)'):src.index('Q=[')], ns)
exec(src[src.index('def elig('):src.index('def job(')], ns)
bm25, elig = ns['bm25'], ns['elig']
def bg(t): t = re.sub(r'\s+', '', t.lower()); return {t[i:i+2] for i in range(len(t)-1)}
stat = {'judged': len(J), 'error': 0, 'not_standalone': 0, 'no_gold': 0}
cases = []
for j in J:
    if 'error' in j: stat['error'] += 1; continue
    if not j['standalone']: stat['not_standalone'] += 1; continue
    gold = [i for i, s in j['scores'].items() if s == 2]
    if not gold: stat['no_gold'] += 1; continue
    q = Q[j['qid']]
    gs = [meta[i]['session'] for i in gold]
    qb = bg(q['text']); cov = max((len(qb & bg(corpus[i]['content'])) / max(1, len(qb)) for i in gold), default=0)
    found_by = sorted({s for i in gold for s in j['pool'][i]})
    cases.append({'id': 'u' + j['qid'][1:], 'query': q['text'], 'gold_ids': gold,
        'gold_text': [corpus[i]['content'][:400] for i in gold],
        'source': {'query_session': q['session'], 'query_turn': q['turn'], 'query_at': q['at'], 'cwd': q['cwd'],
                   'gold_sessions': gs, 'gold_kinds': [corpus[i]['kind'] for i in gold], 'pooled_by': found_by,
                   'judge': 'deepseek-v4.1-flash', 'need': j['need']},
        'why_unbiased': f"query 是真实用户轮 ({q['session'][8:16]}#{q['turn']}), 按固定规则 Q1-Q8 抽样、抽样时未看检索结果; gold 由盲判官从 BM/H0/随机混合候选池判 2 分; gold 全部来自其他会话 ({len(set(gs))} 个), 非 context 类, 写入早于 query; query 与 gold 字 bigram 覆盖率 {cov:.2f}",
        '_cov': cov})
stat['cases'] = len(cases)
def rank_lists(c):
    q = Q['q' + c['id'][1:]]; el = [i for i in corpus if elig(i, q)]
    rnd = random.Random(int(c['id'][1:]) + 777); rp = el[:]; rnd.shuffle(rp)
    return {'BM': bm25(q['text'], el), 'H0': [x for x in runs['q' + c['id'][1:]]['H0'] if elig(x, q)], 'RAND': rp}
def m(lst, gold, k): return len(set(lst[:k]) & set(gold)) / len(gold)
def hit(lst, gold, k): return 1.0 if set(lst[:k]) & set(gold) else 0.0
def rr(lst, gold):
    for n, x in enumerate(lst[:50], 1):
        if x in gold: return 1 / n
    return 0.0
per = []
for c in cases:
    L = rank_lists(c); g = c['gold_ids']
    per.append({sys_: {'R@1': m(l, g, 1), 'R@5': m(l, g, 5), 'R@10': m(l, g, 10), 'Hit@5': hit(l, g, 5), 'Hit@10': hit(l, g, 10), 'MRR': rr(l, g), 'top3': l[:3]} for sys_, l in L.items()})
def mean(xs): return sum(xs) / len(xs) if xs else float('nan')
def boot(vals, B=2000, seed=20261103):
    r = random.Random(seed); n = len(vals); ms = sorted(mean([vals[r.randrange(n)] for _ in range(n)]) for _ in range(B))
    return ms[int(.025 * B)], ms[int(.975 * B)]
out = {'stat': stat, 'systems': {}, 'strata': {}}
for s in ('BM', 'H0', 'RAND'):
    out['systems'][s] = {k: [round(mean([p[s][k] for p in per]), 3), *[round(x, 3) for x in boot([p[s][k] for p in per])]] for k in ('R@1', 'R@5', 'R@10', 'Hit@5', 'Hit@10', 'MRR')}
for name, sel in (('low_cov<0.3', lambda c: c['_cov'] < 0.3), ('high_cov>=0.3', lambda c: c['_cov'] >= 0.3)):
    idx = [n for n, c in enumerate(cases) if sel(c)]
    out['strata'][name] = {'n': len(idx), **{s: {k: round(mean([per[n][s][k] for n in idx]), 3) for k in ('R@5', 'R@10', 'MRR')} for s in ('BM', 'H0', 'RAND')}}
for k in ('R@5', 'R@10', 'MRR'):
    d = [p['BM'][k] - p['H0'][k] for p in per]; out.setdefault('diff_BM_minus_H0', {})[k] = [round(mean(d), 3), *[round(x, 3) for x in boot(d)]]
covs = sorted(c['_cov'] for c in cases); out['cov'] = {'p50': round(covs[len(covs)//2], 3), 'p90': round(covs[int(.9*len(covs))], 3), 'eq1': sum(1 for x in covs if x >= 1)} if covs else {}
out['gold_kinds'] = {}
for c in cases:
    for k in c['source']['gold_kinds']: out['gold_kinds'][k] = out['gold_kinds'].get(k, 0) + 1
out['gold_total'] = sum(len(c['gold_ids']) for c in cases)
out['pooled_only_by'] = {}
for c, j in ((c, next(x for x in J if x['qid'] == 'q' + c['id'][1:])) for c in cases):
    for g in c['gold_ids']:
        key = '+'.join(sorted(j['pool'][g])); out['pooled_only_by'][key] = out['pooled_only_by'].get(key, 0) + 1
out['qual'] = []
for c, p in list(zip(cases, per))[:5]:
    out['qual'].append({'id': c['id'], 'query': c['query'][:120], 'gold': [corpus[g]['content'][:80] for g in c['gold_ids'][:2]],
        'BM_top3': [('★' if x in c['gold_ids'] else '') + corpus[x]['content'][:60] for x in p['BM']['top3']],
        'H0_top3': [('★' if x in c['gold_ids'] else '') + corpus[x]['content'][:60] for x in p['H0']['top3']]})
with open('tests/fixtures/eval/unbiased/cases.jsonl', 'w') as f:
    for c in cases: c.pop('_cov'); f.write(json.dumps(c, ensure_ascii=False) + '\n')
json.dump(out, open('.tmp/unbiased/metrics-lex.json', 'w'), ensure_ascii=False, indent=1)
print(json.dumps(out, ensure_ascii=False, indent=1))
