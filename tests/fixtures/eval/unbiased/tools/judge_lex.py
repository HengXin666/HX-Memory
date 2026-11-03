"""无偏评测集 第 3 步: 相关性标注 (判官 = 本机 deepseek-v4.1-flash, 与 JUDGE-SETUP.md 同一端点; 判官不知道候选来自哪一路检索)。
词法版 (2026-11-03 22:25 改, 语义通道放弃): 候选池 = 合格条目里 BM (BM25 字 bigram 朴素 baseline) 与 H0 (现有方案) 各自 top-10 的并集 + 6 条随机合格条目, 打乱顺序后给判官。
合格 = 非 context 类、来源会话已知且 != query 会话、写入时间早于 query。
用法: python3 judge.py <起始序号> <条数>  → 追加 .tmp/unbiased/judged-lex.jsonl"""
import json,sys,os,re,math,random,requests,concurrent.futures as cf
from collections import Counter
key=re.search(r'WOA_API_KEY\s*:\s*["\']?([^"\'\s]+)',open(os.path.expanduser('~/.dsh/.credentials.yaml')).read()).group(1)
URL='http://127.0.0.1:15721/tencent/v1/chat/completions'; MODEL='deepseek-v4.1-flash'
corpus={e['id']:e for e in json.load(open('.tmp/bench/corpus-r2.json'))['entries']}
meta=json.load(open('.tmp/unbiased/meta.json'))
runs={r['qid']:r for r in json.load(open('.tmp/unbiased/runs-lex.json'))}
def bg(t): t=re.sub(r'\s+','',t.lower()); return [t[i:i+2] for i in range(len(t)-1)] or [t]
DOC={i:Counter(bg(e['content'])) for i,e in corpus.items()}; DL={i:sum(c.values()) for i,c in DOC.items()}; AVG=sum(DL.values())/len(DL)
DF=Counter(); [DF.update(c.keys()) for c in DOC.values()]; NN=len(DOC)
def bm25(q,ids,k1=1.2,b=0.75):
    qt=set(bg(q)); sc={}
    for i in ids:
        c=DOC[i]; s=0.0
        for t in qt:
            f=c.get(t)
            if f: s+=math.log(1+(NN-DF[t]+.5)/(DF[t]+.5))*f*(k1+1)/(f+k1*(1-b+b*DL[i]/AVG))
        sc[i]=s
    return [i for i in sorted(sc,key=lambda x:-sc[x]) if sc[i]>0]
Q=[json.loads(l) for l in open('.tmp/unbiased/qpool.jsonl')]
a,n=int(sys.argv[1]),int(sys.argv[2])
done={json.loads(l)['qid'] for l in open('.tmp/unbiased/judged-lex.jsonl')} if os.path.exists('.tmp/unbiased/judged-lex.jsonl') else set()
PROMPT="""你是检索评测的相关性标注员。下面是一位开发者在编码助手会话里说的一句话 (query), 以及若干条来自**其他过往会话**的记忆条目。
第一步: 判断 query 是否「独立可读的真实需求」: 不看上下文, 外人也能看出他具体想要什么 (要做什么事 / 问什么问题 / 定什么规矩)。纯情绪、纯指代 (如「这个」「那个」而无对象)、纯确认, 都算 false。
第二步: 对每条记忆打分: 2 = 处理这句 query 时, 这条记忆里的知识/教训/决定/偏好**直接用得上** (助手应当知道它); 1 = 同一话题但对这次处理没有实质帮助; 0 = 无关。
只输出 JSON: {"standalone": true/false, "need": "一句话复述需求(standalone 为 false 则空)", "scores": {"<编号>": 0|1|2, ...}}

query: %s

记忆:
%s"""
def elig(id_,q):
    m=meta.get(id_); return m and m['kind']!='context' and m['session'] and m['session']!=q['session'] and m['at']<=q['time']
def job(q):
    r=runs[q['qid']]; rnd=random.Random(int(q['qid'][1:])+20261103)
    pool=[]; src={}
    allel=[i for i in corpus if elig(i,q)]
    for k,lst in (('BM',bm25(q['text'],allel)),('H0',[x for x in r['H0'] if elig(x,q)])):
        for i in lst[:10]: src.setdefault(i,[]).append(k)
    for i in rnd.sample(allel,min(6,len(allel))): src.setdefault(i,[]).append('RAND')
    ids=list(src); rnd.shuffle(ids)
    body='\n'.join(f'[{j}] ({corpus[i]["kind"]}) {corpus[i]["content"][:300]}' for j,i in enumerate(ids))
    for attempt in range(3):
        try:
            resp=requests.post(URL,headers={'Authorization':'Bearer '+key},json={'model':MODEL,'temperature':0.0,'messages':[{'role':'user','content':PROMPT%(q['text'],body)}],'response_format':{'type':'json_object'}},timeout=120).json()
            txt=resp['choices'][0]['message']['content']; o=json.loads(re.search(r'\{.*\}',txt,re.S).group(0))
            sc={ids[int(k)]:int(v) for k,v in o.get('scores',{}).items() if k.isdigit() and int(k)<len(ids)}
            return {'qid':q['qid'],'standalone':bool(o.get('standalone')),'need':o.get('need',''),'pool':{i:src[i] for i in ids},'scores':sc,'eligible':len(allel)}
        except Exception as e: err=str(e)[:200]
    return {'qid':q['qid'],'error':err}
todo=[q for q in Q[a:a+n] if q['qid'] not in done]
with cf.ThreadPoolExecutor(8) as ex, open('.tmp/unbiased/judged-lex.jsonl','a') as f:
    for res in ex.map(job,todo): f.write(json.dumps(res,ensure_ascii=False)+'\n'); f.flush()
print('judged',len(todo))
