import json,re,collections,sys
cs=json.load(open('.tmp/bench/cases-r2-s200.json'))['cases']
corp={e['id']:e for e in json.load(open('.tmp/bench/corpus-r2-s400.json'))['entries']}
n=len(cs); same=sum(1 for c in cs if '同会话后续轮' in c['why'])
print('a cases',n,'同会话后续轮',same,same/n)
gold=[g for c in cs for g in c['expect']]
k=collections.Counter(corp[g]['kind'] if g in corp else 'MISSING' for g in gold)
print('b gold ids',len(gold),k.most_common(), 'context share',k['context']/len(gold))
ug=set(gold); ku=collections.Counter(corp[g]['kind'] for g in ug if g in corp); print('  unique gold',len(ug),ku.most_common(),'context',ku['context']/len(ug))
def bg(t):
  x=re.sub(r'\s+','',t); return {x[i:i+2] for i in range(len(x)-1)}
def ov(q,gs):
  qa=bg(q);b=0
  for g in gs:
    gb=bg(corp.get(g,{}).get('content',''));i=len(qa&gb);u=len(qa|gb);b=max(b,i/u if u else 0)
  return b
def cov(q,gs):  # fraction of query bigrams present in gold
  qa=bg(q);b=0
  for g in gs:
    gb=bg(corp.get(g,{}).get('content',''));b=max(b,len(qa&gb)/len(qa) if qa else 0)
  return b
import statistics
J=sorted(ov(c['query'],c['expect']) for c in cs); C=sorted(cov(c['query'],c['expect']) for c in cs)
p=lambda xs,q: xs[min(len(xs)-1,int(q*len(xs)))]
print('c jaccard p50 %.3f p90 %.3f max %.3f'%(p(J,.5),p(J,.9),J[-1]))
print('c query-coverage p50 %.3f p90 %.3f'%(p(C,.5),p(C,.9)), 'share cov==1:',sum(x>=0.999 for x in C)/n)
print('projects',collections.Counter(c['project'] for c in cs).most_common(8))
