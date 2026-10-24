// external/open.ts — 按环境变量选出引擎。没有地址就用词面投影，调用方不用改。
import { DEFAULT_KNOWLEDGE_ENGINE, DEFAULT_MEMORY_ENGINE } from "./bakeoff.ts";
import { hindsightMemoryEngine } from "./hindsight.ts";
import { lexicalKnowledgeEngine, lexicalMemoryEngine } from "./lexical.ts";
import { lightRagKnowledgeEngine } from "./lightrag.ts";
import { mem0MemoryEngine } from "./mem0.ts";
import { ragflowKnowledgeEngine } from "./ragflow.ts";
import type { KnowledgeEngine, MemoryEngine } from "./ports.ts";

export interface OpenedEngines {
  memory: MemoryEngine;
  knowledge: KnowledgeEngine;
  /** 实际在跑的 id。没有地址时是 lexical，不是 bakeoff 里的默认名。 */
  memoryId: string;
  knowledgeId: string;
  /** 想用的引擎。 */
  wantedMemory: string;
  wantedKnowledge: string;
  memoryFallback?: string;
  knowledgeFallback?: string;
  timeoutMs: number;
}

export function openEngines(env: NodeJS.ProcessEnv = process.env): OpenedEngines {
  const timeoutMs = positiveInt(env.HX_ENGINE_TIMEOUT_MS, 1500);
  const wantedMemory = (env.HX_MEMORY_ENGINE ?? DEFAULT_MEMORY_ENGINE).trim().toLowerCase();
  const wantedKnowledge = (env.HX_KNOWLEDGE_ENGINE ?? DEFAULT_KNOWLEDGE_ENGINE).trim().toLowerCase();
  const memory = pickMemory(wantedMemory, env, timeoutMs);
  const knowledge = pickKnowledge(wantedKnowledge, env, timeoutMs);
  return { ...memory, ...knowledge, wantedMemory, wantedKnowledge, timeoutMs };
}

function pickMemory(
  choice: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Pick<OpenedEngines, "memory" | "memoryId" | "memoryFallback"> {
  if (choice === "lexical") return { memory: lexicalMemoryEngine(), memoryId: "lexical" };
  const url = memoryUrl(choice, env);
  if (!url) {
    return {
      memory: lexicalMemoryEngine(),
      memoryId: "lexical",
      memoryFallback: choice + " 没有地址，改用进程内词面投影",
    };
  }
  const http = { baseUrl: url, timeoutMs, ...(env.HX_MEMORY_API_KEY ? { apiKey: env.HX_MEMORY_API_KEY } : {}) };
  if (choice === "mem0") return { memory: mem0MemoryEngine(http), memoryId: "mem0" };
  if (choice === "hindsight") return { memory: hindsightMemoryEngine(http), memoryId: "hindsight" };
  return {
    memory: lexicalMemoryEngine(),
    memoryId: "lexical",
    memoryFallback: "不认识的记忆引擎 " + choice,
  };
}

function pickKnowledge(
  choice: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Pick<OpenedEngines, "knowledge" | "knowledgeId" | "knowledgeFallback"> {
  if (choice === "lexical") return { knowledge: lexicalKnowledgeEngine(), knowledgeId: "lexical" };
  const url = knowledgeUrl(choice, env);
  if (!url) {
    return {
      knowledge: lexicalKnowledgeEngine(),
      knowledgeId: "lexical",
      knowledgeFallback: choice + " 没有地址，改用进程内词面投影",
    };
  }
  if (choice === "lightrag") {
    return { knowledge: lightRagKnowledgeEngine({ baseUrl: url, timeoutMs }), knowledgeId: "lightrag" };
  }
  if (choice === "ragflow") {
    return {
      knowledge: ragflowKnowledgeEngine({
        baseUrl: url,
        timeoutMs,
        apiKey: env.HX_RAGFLOW_API_KEY ?? "",
      }),
      knowledgeId: "ragflow",
    };
  }
  return {
    knowledge: lexicalKnowledgeEngine(),
    knowledgeId: "lexical",
    knowledgeFallback: "不认识的知识库引擎 " + choice,
  };
}

function memoryUrl(choice: string, env: NodeJS.ProcessEnv): string {
  if (choice === "mem0") return clean(env.HX_MEM0_BASE_URL) || clean(env.HX_MEMORY_ENGINE_URL);
  if (choice === "hindsight") return clean(env.HX_HINDSIGHT_BASE_URL) || clean(env.HX_MEMORY_ENGINE_URL);
  return "";
}

function knowledgeUrl(choice: string, env: NodeJS.ProcessEnv): string {
  if (choice === "lightrag") return clean(env.HX_LIGHTRAG_BASE_URL) || clean(env.HX_KNOWLEDGE_ENGINE_URL);
  if (choice === "ragflow") return clean(env.HX_RAGFLOW_BASE_URL) || clean(env.HX_KNOWLEDGE_ENGINE_URL);
  return "";
}

function clean(value: string | undefined): string {
  return value?.trim() ?? "";
}

function positiveInt(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
