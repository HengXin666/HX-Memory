"""无偏评测集 第 1 步: 从真实用户轮里按固定规则选 query 候选 (不看任何检索结果)。
规则 Q1-Q7 见 MANIFEST.md。输出 .tmp/unbiased/qpool.jsonl"""
import json,re,random,collections,datetime
SEED=20261103
U=[json.loads(l) for l in open('.tmp/unbiased/user-turns.jsonl')]
ACK=re.compile(r'^(继续|好的?|ok|OK|可以|行|嗯|是的|对|不用|没问题|go|next|快点)[!！。.]*$')
def keep(u):
    t=u['text'].strip(); b=u['bucket']
    if any(x in b for x in ('--tmp-','sec-test','browser-sessions')): return 'Q1 bucket'
    if not (12<=len(t)<=200): return 'Q2 len'
    if t.count('\n')>2: return 'Q3 multiline'
    if '```' in t or re.search(r'^\s*[/$#>]',t) or re.search(r'Traceback|at .+\(.+:\d+\)|\berror\b.*:\s*\S+\.\w+:\d+',t): return 'Q4 code/log'
    if len(re.findall(r'[\u4e00-\u9fff]',t))<6: return 'Q5 cjk'
    if ACK.match(t): return 'Q6 ack'
    if re.search(r'https?://|[A-Za-z]:\\|/home/|<[a-z-]+>|\[tool|\[image',t): return 'Q4 code/log'
    return None
dt=lambda ms: datetime.datetime.fromtimestamp(ms/1000,datetime.timezone(datetime.timedelta(hours=8)))
why=collections.Counter(); seen=set(); ok=[]
for u in U:
    r=keep(u)
    if r is None and (u['time'] or 0) < datetime.datetime(2026,9,12,tzinfo=datetime.timezone(datetime.timedelta(hours=8))).timestamp()*1000: r='Q7 too-early'
    if r is None and u['text'].strip() in seen: r='Q6 dup'
    why[r or 'kept']+=1
    if r is None: seen.add(u['text'].strip()); ok.append(u)
random.seed(SEED); random.shuffle(ok)
per=collections.Counter(); pool=[]
for u in ok:
    if per[u['session']]>=2: why['Q8 per-session cap']+=1; continue
    per[u['session']]+=1; pool.append(u)
pool=pool[:420]
for i,u in enumerate(pool): u['qid']='q%03d'%i; u['at']=dt(u['time']).isoformat()
open('.tmp/unbiased/qpool.jsonl','w').write('\n'.join(json.dumps(u,ensure_ascii=False) for u in pool)+'\n')
print(json.dumps({'turns':len(U),'reasons':why,'pool':len(pool),'sessions':len(per)},ensure_ascii=False))
