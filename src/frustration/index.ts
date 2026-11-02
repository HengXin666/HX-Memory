// src/frustration/index.ts — 挫折链路的对外出口。
export { createDetector, maskTechTerms, TECH_TERMS, NO_FRUSTRATION, type FrustrationDetector, type FrustrationJudge, type FrustrationSignal } from "./detect.ts";
export { latestUserMessage, SeenMessages, isDirectUser, textOf, type UserMessageRef } from "./dedupe.ts";
export { buildReviewInput, parseLesson, isConcrete, REVIEW_SYSTEM_PROMPT, reviewUserPrompt, TASK_TYPES, TEMPLATE_PHRASES, type Lesson, type LessonScope, type ReviewInput } from "./review.ts";
export { LessonStore, appliesTo, formatLesson } from "./rules.ts";
export { FrustrationPipeline, type FrustrationPipelineDeps, type ReviewModel, type StepInput, type PipelineStats } from "./pipeline.ts";
export { locateWorkspace, recentDiff } from "./workspace.ts";
