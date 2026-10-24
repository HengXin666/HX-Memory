/** Historical v1 fixture classification only; this is not a v2 verdict. */
/** 非平凡面: 命中即要求带 Note。 */
const NON_TRIVIAL = [
  /^src\//,
  /^\.agents\/rules\//,
  /^scripts\//,
  /^dsh\//,
  /^\.github\/workflows\//,
  /^package\.json$/,
  /^tsconfig[^/]*\.json$/,
];

/** 满足条件: 出现这些改动即视为"带了 Note"。 */
const NOTE_PATTERN = /^\.agents\/notes\/(proposed|implemented|rejected)\/.+\.md$/;

/** 豁免: 纯测试/纯文档 (非规则类) 改动不要求 Note。 
 * .agents/notes/implemented/process/2026-09-10-agent-note-sedimentation-flow.md
 */
const EXEMPT = [/^tests\//, /^docs\//, /^\.agents\/skills\//, /^README/, /^\.agents\/notes\//];

export interface CoverageVerdict {
  ok: boolean;
  /** 命中"非平凡面"且未被豁免的文件。 */
  nonTrivial: string[];
  /** 本次改动是否带了 Agent Note。 */
  noteTouched: boolean;
}

/**
 * 纯函数判定 (导出是为了可测试): 给定改动文件列表, 判断是否满足"非平凡改动必须带 Note"。
 * 一个"永远通过"的 gate 比没有 gate 更糟  所以判定逻辑必须能被逐个断言。
 */
export function classifyChange(files: readonly string[]): CoverageVerdict {
  const noteTouched = files.some((file) => NOTE_PATTERN.test(file));
  const nonTrivial = files.filter(
    (file) => NON_TRIVIAL.some((re) => re.test(file)) && !EXEMPT.some((re) => re.test(file)),
  );
  return { ok: noteTouched || nonTrivial.length === 0, nonTrivial, noteTouched };
}

