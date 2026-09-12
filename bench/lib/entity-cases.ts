// bench/lib/entity-cases.ts — 生成 entity_only case: 只有"实体反查"才可能答对的查询。
//
// 为什么需要它: `lib/graph-cases.ts` 依赖库里**已存的 relations**, 而库里的边少且多为
// generalizes, 最终只生成出 4 条 —— 样本太小, 任何策略差异都测不出来 (实测三种建边策略
// 在那 4 条上结果完全相同)。本文件绕开"已存的边", 直接按**实体共享 + 字面不重合**配对:
//
//   query  = A 的唯一探针 (字面只指向 A)
//   expect = B, 且 B 与 A 的字面重合 <= 0.12
//   约束   = A 与 B 至少共享一个实体
//
// 只有这样, "A 与 B 之间有没有可用的边"才成为唯一变量。实测在真实库上生成 104 条,
// 并据此定位到真瓶颈是**检索期的图配额**而不是写入期的建边策略。
//
// 用法: node --experimental-strip-types bench/lib/entity-cases.ts [--out FILE]
import { writeFileSync, readFileSync } from "node:fs";
import type { Corpus } from "../../bench/lib/corpus.ts";
const corpus = JSON.parse(readFileSync(".tmp/bench/corpus.json","utf8")) as Corpus;

const CANDIDATES = ["HX-Memory","FTS5","MMR","bge-small-zh","prestep.ts","hybrid.ts","mem0","Graphiti",
  "DSH","MCP","ADR","SQLite","Intl.Segmenter","embedding-http.ts","facade.ts","runtime.ts","HXLoLi","gh-registrar","freebuff-proxy","panel"];
const entitiesOf = (t:string) => CANDIDATES.filter(c=>t.includes(c));

function grams(s:string): Set<string> {
  const n = s.toLowerCase().replace(/[^0-9a-z\u4e00-\u9fff]+/g,"");
  const out = new Set<string>();
  for (let i=0;i+2<=n.length;i++) out.add(n.slice(i,i+2));
  return out;
}
function overlapOf(a:string,b:string): number {
  const x=grams(a), y=grams(b);
  if (!x.size||!y.size) return 0;
  let i=0; for (const t of x) if (y.has(t)) i++;
  return i/x.size;
}
function uniqueProbe(text:string, others:string): string|null {
  const positions=[0.15,0.4,0.65,0.9].map(p=>Math.floor(text.length*p));
  for (const start of positions) {
    for (let len=20; len>=6; len--) {
      const slice=text.slice(start,start+len).trim();
      if (slice.length<6||/\s/.test(slice)||/^[\p{P}\p{S}]+$/u.test(slice)) continue;
      if (others.includes(slice)) break;
      return slice;
    }
  }
  return null;
}
const ents = new Map(corpus.entries.map(e=>[e.id, entitiesOf(e.content)]));
const allText = corpus.entries.map(e=>e.content).join("\n");
const cases: Array<Record<string,unknown>> = [];
const seen = new Set<string>();
for (const a of corpus.entries) {
  const ea = ents.get(a.id)!;
  if (!ea.length) continue;
  for (const b of corpus.entries) {
    if (a.id===b.id) continue;
    const shared = ea.filter(x=>ents.get(b.id)!.includes(x));
    if (!shared.length) continue;
    // 只保留**字面不重合**的配对 —— 否则 b 本来就能被词面找到, 不构成图专属 case
    const ov = overlapOf(a.content, b.content);
    if (ov > 0.12) continue;
    const probe = uniqueProbe(a.content, allText.replace(a.content,""));
    if (!probe) continue;
    const key = a.id+"→"+b.id;
    if (seen.has(key)) continue;
    seen.add(key);
    cases.push({ id:"c-entityonly-"+String(cases.length).padStart(4,"0"), type:"entity_only",
      query:probe, expect:[b.id], seed:a.id, sharedEntities:shared,
      note:"共享实体 " + shared.join(",") + " 但字面重合仅 " + ov.toFixed(2) });
  }
}
const outIdx = process.argv.indexOf("--out");
const outPath = outIdx >= 0 ? (process.argv[outIdx + 1] ?? ".tmp/bench/cases-entity-only.json")
                            : ".tmp/bench/cases-entity-only.json";
writeFileSync(outPath, JSON.stringify({ schema: "hxmem-cases-entity/1", cases }, null, 2));
console.log("entity_only case:", cases.length, "条");
const byEnt: Record<string,number> = {};
for (const c of cases) for (const e of c.sharedEntities as string[]) byEnt[e]=(byEnt[e]??0)+1;
console.log("按共享实体分布 (前 8):", JSON.stringify(Object.entries(byEnt).sort((a,b)=>b[1]-a[1]).slice(0,8)));
console.log("");
console.log("这批 case 的判据: query 取自 A 且字面只指向 A; 目标是 B, 与 A 字面重合 <=0.12;");
console.log("两者唯一的桥是共享实体 → 只有'实体边 + 图扩展'才能拿到 B。");
console.log("输出: " + outPath);