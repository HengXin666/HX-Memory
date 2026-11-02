"""scripts/eval/eval-set-audit.py — EVAL-CRITIQUE.md 的证据脚本 (只读): 挫折集来源分布、K1/K2 槽位分布、博客语料分布。
用法: python3 scripts/eval/eval-set-audit.py   (在仓库根执行; 博客根默认 /home/hx/Loli/code/HXLoLis/HXLoLi, 可用环境变量 HX_KB_ROOT 覆盖)
"""
print("== 1 挫折集 samples.jsonl")
import json,collections,ast,glob,os,re
S=[json.loads(l) for l in open('tests/fixtures/eval/frustration/samples.jsonl') if l.strip()]
src=[s['source'] if isinstance(s['source'],dict) else ast.literal_eval(s['source']) for s in S]
b=collections.Counter(x['bucket'] for x in src); print('buckets',len(b),b.most_common())
ses=collections.Counter(x['session'] for x in src); print('sessions',len(ses),'top',ses.most_common(5))
print('format',collections.Counter(x.get('format') for x in src))
lh=collections.Counter((x.get('loose_hit'), s['label']!='none') for x,s in zip(src,S)); print('loose_hit x positive',lh)
pos=[s for s in S if s['label']!='none']
print('pos by bucket',collections.Counter(x['bucket'] for x,s in zip(src,S) if s['label']!='none'))
print('tech_terms nonempty in none:',sum(1 for s in S if s['label']=='none' and s['tech_terms']!='[]'))
L=[len(s['text']) for s in S]; print('len median',sorted(L)[len(L)//2],'<=12:',sum(l<=12 for l in L))
# all buckets on disk
bk=[d for d in os.listdir(os.path.expanduser('~/.dsh/sessions'))]; print('disk buckets',len(bk))
cnt={d:len(glob.glob(os.path.expanduser(f'~/.dsh/sessions/{d}/session-*'))) for d in bk}
print(sorted(cnt.items(),key=lambda x:-x[1])[:12])
# who labeled
for f in ['agreement.json']: print(f, os.path.exists('tests/fixtures/eval/frustration/'+f))
reg=[json.loads(l) for l in open('tests/fixtures/eval/frustration/regression.jsonl') if l.strip()]; print('regression',len(reg),reg[0])
print("== 2 K1/K2 槽位")
import json,collections,os
Q=[json.loads(l) for l in open('tests/fixtures/eval/kb-queries.jsonl') if l.strip()]
print(collections.Counter((q['dir'],q['kind']) for q in Q))
cross=[q for q in Q if q['kind']=='cross']
same=sum(1 for q in cross if len({os.path.dirname(p) for p in q['expect_paths']})==1)
print('cross n',len(cross),'paths per',collections.Counter(len(q['expect_paths']) for q in cross),'same-dir',same)
print(cross[0]); print([q for q in Q if q['kind']=='detail'][0])
B=os.environ.get('HX_KB_ROOT','/home/hx/Loli/code/HXLoLis/HXLoLi')
for d in ['blog','ai-docs','docs']:
  n=0
  for r,ds,fs in os.walk(f'{B}/{d}'):
    ds[:]=[x for x in ds if not x.startswith('.') and x!='node_modules']
    n+=sum(1 for f in fs if f.endswith(('.md','.mdx')) and not f.startswith('.'))
  print('corpus',d,n)
yrs=collections.Counter(q['expect_paths'][0].split('/')[1] for q in Q if q['dir']=='blog'); print('blog years',yrs)
print("== 3 docs/ 目录分布")
import os,collections,json
B=os.environ.get('HX_KB_ROOT','/home/hx/Loli/code/HXLoLis/HXLoLi')+'/docs'
c=collections.Counter()
for r,ds,fs in os.walk(B):
  ds[:]=[x for x in ds if not x.startswith('.') and x!='node_modules']
  rel=os.path.relpath(r,B).split('/')
  key='/'.join(rel[:2])
  c[key]+=sum(1 for f in fs if f.endswith(('.md','.mdx')) and not f.startswith('.'))
print(c.most_common(15))
Q=[json.loads(l) for l in open('tests/fixtures/eval/kb-queries.jsonl') if l.strip()]
print(collections.Counter('/'.join(q['expect_paths'][0].split('/')[1:3]) for q in Q if q['dir']=='docs').most_common(10))
