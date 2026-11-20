import { EMBEDDING_MODEL } from "../models.js";
import { isRetryableStatus, ProviderError, toProviderError } from "./error.js";
import { OPENROUTER_DEFAULT_REFERER, OPENROUTER_DEFAULT_TITLE } from "./openrouter.js";

// Source: https://platform.openai.com/docs/api-reference/embeddings/create — checked 2026-11-14
const OPENAI_EMBEDDINGS_URL = "https://api.openai.com/v1/embeddings";

// Source: https://openrouter.ai/docs/api-reference/embeddings — checked 2026-11-15
const OPENROUTER_EMBEDDINGS_URL = "https://openrouter.ai/api/v1/embeddings";
const OPENROUTER_EMBEDDING_MODEL = `openai/${EMBEDDING_MODEL.id}`;

// Source: https://developers.openai.com/api/reference/resources/embeddings/methods/create — checked 2026-11-14
// OpenAI's embeddings endpoint accepts up to 2,048 inputs per request, and at
// most 300,000 tokens summed across all inputs in one request.
export const OPENAI_EMBEDDING_BATCH_LIMIT = 2048;
export const OPENAI_EMBEDDING_MAX_TOKENS_PER_REQUEST = 300_000;
// Tokens are counted by the provider, not here, and the engine ships no
// tokenizer. The budget is measured in UTF-8 bytes rather than characters:
// CJK or emoji-heavy text can take more than one token per character, but
// several bytes per character too, so a byte budget below the token cap is far
// less likely to overshoot it. It is still an estimate, so a request the
// provider refuses with 400 is split in half and retried (see `embedBatch`).
export const OPENAI_EMBEDDING_MAX_BYTES_PER_REQUEST = 250_000;

// Source: https://developers.cloudflare.com/vectorize/platform/limits/ — checked 2026-11-14
// "Upsert batch size: 1000 (Workers) / 5000 (HTTP API)".
export const VECTORIZE_UPSERT_BATCH_LIMIT = 1000;
// The same page states no limit for `deleteByIds`; deletes use the upsert
// batch size so one call never carries more ids than one upsert would.
export const VECTORIZE_DELETE_BATCH_LIMIT = VECTORIZE_UPSERT_BATCH_LIMIT;
// The same page: "Maximum returned results (`topK`) without values and
// metadata: 100". Queries here ask for neither.
export const VECTORIZE_MAX_TOP_K = 100;

export interface EmbedResult {
  vectors: number[][];
}

/**
 * Receives the tokens one provider request billed. It is awaited before the
 * next request is sent, so spend already incurred is reported even when a
 * later request, or whatever the caller does with the vectors, fails.
 */
export type EmbeddingBilled = (tokens: number) => Promise<void>;

export interface Embedder {
  readonly dimensions: number;
  /**
   * `onBilled` is the only channel for embedding usage: it runs once per
   * provider request that billed tokens, and the result carries no total, so
   * a caller cannot count the same tokens twice.
   */
  embed(
    texts: string[],
    onBilled: EmbeddingBilled,
    options?: { signal?: AbortSignal | undefined },
  ): Promise<EmbedResult>;
}

export interface VectorRecord {
  chunkId: string;
  vector: number[];
  orgId: string;
  assistantId: string;
}

export interface RetrievedChunk {
  chunkId: string;
  score: number;
}

export interface Retriever {
  upsert(vectors: VectorRecord[]): Promise<void>;
  /**
   * `orgId` and `assistantId` are required arguments, not optional hints:
   * a query that omitted them could return another org's chunks.
   */
  query(args: {
    vector: number[];
    orgId: string;
    assistantId: string;
    topK: number;
    signal?: AbortSignal | undefined;
  }): Promise<RetrievedChunk[]>;
  remove(chunkIds: string[]): Promise<void>;
}

export interface OpenAIEmbedderOptions {
  apiKey: string;
  model?: string | undefined;
  dimensions?: number | undefined;
  fetchImpl?: typeof fetch | undefined;
}

export interface OpenRouterEmbedderOptions {
  apiKey: string;
  httpReferer?: string | undefined;
  title?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
}

interface OpenAIEmbeddingResponse {
  data?: Array<{
    index?: number;
    embedding?: number[];
  }>;
  usage?: { prompt_tokens?: number; total_tokens?: number };
}

const utf8 = new TextEncoder();

/** Splits inputs into requests that respect both the count and size caps. */
function requestBatches(texts: string[]): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  let bytes = 0;
  for (const text of texts) {
    const size = utf8.encode(text).byteLength;
    if (
      current.length > 0 &&
      (current.length >= OPENAI_EMBEDDING_BATCH_LIMIT ||
        bytes + size > OPENAI_EMBEDDING_MAX_BYTES_PER_REQUEST)
    ) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(text);
    bytes += size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** Cost of embedding `tokens` tokens, rounded up so metering never understates. */
export function embeddingCostMicros(tokens: number): number {
  return Math.ceil((tokens * EMBEDDING_MODEL.costMicrosPerMillion) / 1_000_000);
}

interface CompatEmbedderConfig {
  label: string;
  url: string;
  apiKey: string;
  model: string;
  dimensions: number;
  sendDimensions: boolean;
  extraHeaders?: Record<string, string>;
  fetchImpl?: typeof fetch | undefined;
}

function openAICompatibleEmbedder(config: CompatEmbedderConfig): Embedder {
  const { label, url, apiKey, model, dimensions, sendDimensions, extraHeaders } = config;
  const doFetch = config.fetchImpl ?? fetch;

  /** One provider request for `batch`, in input order. */
  async function requestOnce(
    batch: string[],
    onBilled: EmbeddingBilled,
    signal?: AbortSignal,
  ): Promise<number[][]> {
    let response: Response;
    try {
      response = await doFetch(url, {
        method: "POST",
        ...(signal ? { signal } : {}),
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          ...extraHeaders,
        },
        body: JSON.stringify({
          model,
          input: batch,
          ...(sendDimensions ? { dimensions } : {}),
        }),
      });
    } catch (err) {
      throw toProviderError(err, `${label} embeddings request failed`);
    }

    if (!response.ok) {
      throw new ProviderError(
        `${label} embeddings request failed with ${response.status}`,
        isRetryableStatus(response.status),
        response.status,
      );
    }

    let payload: OpenAIEmbeddingResponse;
    try {
      payload = (await response.json()) as OpenAIEmbeddingResponse;
    } catch (err) {
      throw toProviderError(err, `${label} embeddings response was not valid JSON`);
    }

    // Reported before the payload is validated: a malformed body was
    // still billed, and so was this request if a later one fails.
    const billed = payload.usage?.total_tokens ?? payload.usage?.prompt_tokens;
    if (typeof billed === "number" && Number.isFinite(billed) && billed > 0) {
      await onBilled(billed);
    }

    if (!Array.isArray(payload.data) || payload.data.length !== batch.length) {
      throw new ProviderError(`${label} embeddings response length mismatch`, true);
    }

    const ordered: Array<number[] | undefined> = new Array(batch.length);
    for (const item of payload.data) {
      if (
        typeof item.index !== "number" ||
        item.index < 0 ||
        item.index >= batch.length ||
        !Array.isArray(item.embedding)
      ) {
        throw new ProviderError(`${label} embeddings response item malformed`, true);
      }
      ordered[item.index] = item.embedding;
    }

    const vectors: number[][] = [];
    for (const vector of ordered) {
      if (vector === undefined) {
        throw new ProviderError(`${label} embeddings response missing index`, true);
      }
      vectors.push(vector);
    }
    return vectors;
  }

  /**
   * The size budget is an estimate, so a 400 on a request with more than one
   * input is retried as two halves rather than failing the whole document:
   * a non-retryable error would send it to the dead-letter queue unindexed.
   * A single input that still gets 400 fails as before.
   */
  async function embedBatch(
    batch: string[],
    onBilled: EmbeddingBilled,
    signal?: AbortSignal,
  ): Promise<number[][]> {
    try {
      return await requestOnce(batch, onBilled, signal);
    } catch (err) {
      if (signal?.aborted) throw err;
      if (!(err instanceof ProviderError) || err.status !== 400 || batch.length < 2) throw err;
      const mid = Math.ceil(batch.length / 2);
      const first = await embedBatch(batch.slice(0, mid), onBilled, signal);
      const second = await embedBatch(batch.slice(mid), onBilled, signal);
      return [...first, ...second];
    }
  }

  return {
    dimensions,
    async embed(texts, onBilled, embedOptions) {
      if (texts.length === 0) return { vectors: [] };

      const out: number[][] = [];
      for (const batch of requestBatches(texts)) {
        out.push(...(await embedBatch(batch, onBilled, embedOptions?.signal)));
      }
      return { vectors: out };
    },
  };
}

/** Creates an OpenAI Embeddings API client backed by the given API key. */
export function openAIEmbedder(options: OpenAIEmbedderOptions): Embedder {
  return openAICompatibleEmbedder({
    label: "openai",
    url: OPENAI_EMBEDDINGS_URL,
    apiKey: options.apiKey,
    model: options.model ?? EMBEDDING_MODEL.id,
    dimensions: options.dimensions ?? EMBEDDING_MODEL.dimensions,
    sendDimensions: false,
    fetchImpl: options.fetchImpl,
  });
}

/**
 * Creates an OpenRouter Embeddings API client fixed to `openai/text-embedding-3-small`
 * at 1536 dimensions (the Vectorize index size).
 * Source: https://openrouter.ai/docs/api-reference/embeddings — checked 2026-11-15
 */
export function openRouterEmbedder(options: OpenRouterEmbedderOptions): Embedder {
  return openAICompatibleEmbedder({
    label: "openrouter",
    url: OPENROUTER_EMBEDDINGS_URL,
    apiKey: options.apiKey,
    model: OPENROUTER_EMBEDDING_MODEL,
    dimensions: EMBEDDING_MODEL.dimensions,
    sendDimensions: true,
    extraHeaders: {
      "http-referer": options.httpReferer ?? OPENROUTER_DEFAULT_REFERER,
      "x-title": options.title ?? OPENROUTER_DEFAULT_TITLE,
    },
    fetchImpl: options.fetchImpl,
  });
}

/** Metadata properties that `vectorizeRetriever` upserts and filters every query on. */
export const VECTORIZE_METADATA_PROPERTIES = {
  orgId: "org_id",
  assistantId: "assistant_id",
} as const;

/** Vectorize-backed `Retriever` that always filters by `org_id` and `assistant_id`. */
export function vectorizeRetriever(index: VectorizeIndex): Retriever {
  return {
    async upsert(vectors) {
      for (let offset = 0; offset < vectors.length; offset += VECTORIZE_UPSERT_BATCH_LIMIT) {
        await index.upsert(
          vectors.slice(offset, offset + VECTORIZE_UPSERT_BATCH_LIMIT).map((record) => ({
            id: record.chunkId,
            values: record.vector,
            metadata: {
              [VECTORIZE_METADATA_PROPERTIES.orgId]: record.orgId,
              [VECTORIZE_METADATA_PROPERTIES.assistantId]: record.assistantId,
            },
          })),
        );
      }
    },

    async query({ vector, orgId, assistantId, topK }) {
      const result = await index.query(vector, {
        topK,
        filter: {
          [VECTORIZE_METADATA_PROPERTIES.orgId]: orgId,
          [VECTORIZE_METADATA_PROPERTIES.assistantId]: assistantId,
        },
        returnMetadata: "none",
      });
      return result.matches.map((match) => ({
        chunkId: match.id,
        score: match.score,
      }));
    },

    async remove(chunkIds) {
      for (let offset = 0; offset < chunkIds.length; offset += VECTORIZE_DELETE_BATCH_LIMIT) {
        await index.deleteByIds(chunkIds.slice(offset, offset + VECTORIZE_DELETE_BATCH_LIMIT));
      }
    },
  };
}
