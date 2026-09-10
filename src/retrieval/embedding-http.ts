// retrieval/embedding-http.ts — OpenAI 兼容的远端嵌入器 (真·语义检索的接入点)。
//
// 为什么是"OpenAI 兼容"这一种协议: 它是事实上标准 —— OpenAI、Ollama、LM Studio、vLLM、
// TEI、以及多数自建服务都提供 POST {baseUrl}/embeddings 且返回 {data:[{embedding:[...]}]}。
// 实现一个协议就覆盖了本地/自建/云三类部署, 且不引入任何 SDK 依赖 (只用 fetch)。
//
// 定位: 这是**可选**引擎 —— 默认仍是本地零依赖的 HashingEmbedder; 配好端点即升级为真语义。
// 它是异步的, 因此配套 ProjectedVectorIndex 使用 (预步注入同步读投影, 见 ADR-025)。
import type { Embedder } from "../kernel/ports.ts";

export interface OpenAiCompatibleEmbedderOptions {
  /** 形如 "https://api.openai.com/v1" 或 "http://127.0.0.1:11434/v1" (不带末尾斜杠亦可)。 */
  baseUrl: string;
  model: string;
  apiKey?: string;
  /** 向量维度 (用于索引身份; 与服务端实际维度不符时以首次响应为准并告警)。 */
  dim?: number;
  /** 单请求批量 (默认 32)。 */
  batchSize?: number;
  /** 单请求超时 (默认 10s); 超时按失败处理 (投影会把条目放回队列下轮重试)。 */
  timeoutMs?: number;
  /** 自定义 fetch (测试注入)。 */
  fetchImpl?: typeof fetch;
  /** 额外请求头 (自建网关常见)。 */
  headers?: Record<string, string>;
}

interface EmbeddingResponse {
  data?: Array<{ embedding?: number[]; index?: number }>;
}

export class OpenAiCompatibleEmbedder implements Embedder {
  readonly id: string;
  /** 维度在首次成功响应后确定; 声明值仅作初始身份。 */
  dim: number;
  /** 主流文本嵌入模型 (text-embedding-3 / bge-m3 / nomic) 的经验下限。 */
  readonly floor = 0.3;
  private readonly opts: OpenAiCompatibleEmbedderOptions;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: OpenAiCompatibleEmbedderOptions) {
    this.opts = opts;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.dim = opts.dim ?? 0;
    this.id = `openai-compat:${opts.model}@${normalizeBaseUrl(opts.baseUrl)}`;
  }

  async embed(texts: readonly string[]): Promise<number[][]> {
    if (!texts.length) return [];
    const batchSize = Math.max(1, this.opts.batchSize ?? 32);
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += batchSize) {
      out.push(...(await this.embedBatch(texts.slice(i, i + batchSize))));
    }
    return out;
  }

  private async embedBatch(texts: readonly string[]): Promise<number[][]> {
    const url = normalizeBaseUrl(this.opts.baseUrl) + "/embeddings";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 10_000);
    try {
      const response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.opts.apiKey ? { authorization: "Bearer " + this.opts.apiKey } : {}),
          ...(this.opts.headers ?? {}),
        },
        body: JSON.stringify({ model: this.opts.model, input: texts }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(
          `embedding endpoint ${response.status}: ${(await response.text()).slice(0, 200)}`,
        );
      }
      const payload = (await response.json()) as EmbeddingResponse;
      const rows = payload.data ?? [];
      if (rows.length !== texts.length) {
        throw new Error(`embedding count mismatch: expected ${texts.length}, got ${rows.length}`);
      }
      // 按 index 排序 (协议允许乱序返回), 缺 index 时按数组顺序。
      const ordered = rows.every((r) => typeof r.index === "number")
        ? [...rows].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
        : rows;
      const vectors = ordered.map((row) => row.embedding ?? []);
      const first = vectors[0];
      if (first && this.dim === 0) this.dim = first.length;
      if (first && this.dim !== first.length) {
        throw new Error(
          `embedding dim mismatch: index declares ${this.dim}, endpoint returned ${first.length}`,
        );
      }
      return vectors;
    } finally {
      clearTimeout(timer);
    }
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

/** 从宿主环境/设置里读取端点配置 (没有配置就返回 null → 退回本地默认嵌入器)。 */
export function openAiEmbedderFromEnv(
  env: Record<string, string | undefined> = process.env,
): OpenAiCompatibleEmbedder | null {
  const baseUrl = env.HX_MEMORY_EMBEDDING_BASE_URL?.trim();
  const model = env.HX_MEMORY_EMBEDDING_MODEL?.trim();
  if (!baseUrl || !model) return null;
  const dim = Number(env.HX_MEMORY_EMBEDDING_DIM);
  return new OpenAiCompatibleEmbedder({
    baseUrl,
    model,
    ...(env.HX_MEMORY_EMBEDDING_API_KEY ? { apiKey: env.HX_MEMORY_EMBEDDING_API_KEY } : {}),
    ...(Number.isFinite(dim) && dim > 0 ? { dim } : {}),
  });
}
