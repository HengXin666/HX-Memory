// src/frustration/detect-mask.ts — 技术词豁免表与遮罩 (从 detect.ts 拆出, 供 features.ts 复用且不形成循环引用)。

/**
 * 技术词豁免表。命中词表的字面如果落在这些词里面, 不算骂人。
 *
 * 来源: EVAL.md 2.3 指定的技术敏感词 (滚动条、垃圾回收、kill、杀进程、错误码、「错误」作名词),
 * 外加 external/policy.ts 原有的 SUPPRESS, 以及真会话里实测的误报。
 * 以字面子串匹配 (不区分大小写)。
 */
export const TECH_TERMS: readonly string[] = [
  // 「垃圾」
  "垃圾回收", "垃圾收集", "垃圾桶", "垃圾邮件", "垃圾文件", "垃圾数据", "垃圾代码清理", "garbage",
  // 「滚」
  "滚动", "滚轮", "滚日志", "滚动条", "回滚", "滚屏",
  // 「废物」「废话」
  "废物利用", "废弃",
  // 「有病」「不对」「错了」等出现在技术语境里
  "不对齐", "对不对称", "不对称", "错误码", "错误日志", "错误处理", "错误信息", "错误类型", "报错信息",
  "纠错", "容错", "排错", "试错", "查错",
  // 「别」开头的祈使正则会误伤这些词
  "别名", "别的", "别人", "别处", "别称", "区别", "类别", "级别", "识别", "告别", "特别", "分别", "差别", "个别",
  // 「不要」「禁止」出现在需求描述里的常见技术搭配
  "禁止缓存", "禁止访问", "禁止转义",
];

/** 把技术词所在的片段替换成等长空白, 下游词表就碰不到它们。返回遮罩后的文本与被遮掉的词。 */
export function maskTechTerms(text: string, terms: readonly string[] = TECH_TERMS): { masked: string; exempted: string[] } {
  let masked = text;
  const exempted: string[] = [];
  const lower = () => masked.toLowerCase();
  for (const term of terms) {
    const t = term.toLowerCase();
    let at = lower().indexOf(t);
    while (at >= 0) {
      exempted.push(masked.slice(at, at + term.length));
      masked = masked.slice(0, at) + " ".repeat(term.length) + masked.slice(at + term.length);
      at = lower().indexOf(t, at + term.length);
    }
  }
  // 英文 kill 只在「命令/进程」语境里出现; 词表里没有 kill, 这里不需要遮。
  return { masked, exempted };
}
