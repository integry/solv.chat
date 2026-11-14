import { EMBEDDING_MODEL } from "../models.js";
import { isRetryableStatus, ProviderError, toProviderError } from "./error.js";

// Source: https://platform.openai.com/docs/api-reference/embeddings/create — checked 2026-11-14
const OPENAI_EMBEDDINGS_URL = "https://api.openai.com/v1/embeddings";

// Source: https://developers.openai.com/api/reference/resources/embeddings/methods/create — checked 2026-11-14
// OpenAI's embeddings endpoint accepts up to 2,048 inputs per request, and at
// most 300,000 tokens summed across all inputs in one request.
export const OPENAI_EMBEDDING_BATCH_LIMIT = 2048;
export const OPENAI_EMBEDDING_MAX_TOKENS_PER_REQUEST = 300_000;
// Tokens are counted by the provider, not here. A token is never shorter than
// one character for this model's tokenizer in practice, so a character budget
// below the token cap keeps a request under it without shipping a tokenizer.
export const OPENAI_EMBEDDING_MAX_CHARS_PER_REQUEST = 250_000;

// Source: https://developers.cloudflare.com/vectorize/platform/limits/ — checked 2026-11-14
// "Upsert batch size: 1000 (Workers) / 5000 (HTTP API)".
export const VECTORIZE_UPSERT_BATCH_LIMIT = 1000;
// The same page states no limit for `deleteByIds`; deletes use the upsert
// batch size so one call never carries more ids than one upsert would.
export const VECTORIZE_DELETE_BATCH_LIMIT = VECTORIZE_UPSERT_BATCH_LIMIT;

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
  embed(texts: string[], onBilled: EmbeddingBilled): Promise<EmbedResult>;
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
  }): Promise<RetrievedChunk[]>;
  remove(chunkIds: string[]): Promise<void>;
}

export interface OpenAIEmbedderOptions {
  apiKey: string;
  model?: string | undefined;
  dimensions?: number | undefined;
  fetchImpl?: typeof fetch | undefined;
}

interface OpenAIEmbeddingResponse {
  data?: Array<{
    index?: number;
    embedding?: number[];
  }>;
  usage?: { prompt_tokens?: number; total_tokens?: number };
}

/** Splits inputs into requests that respect both the count and size caps. */
function requestBatches(texts: string[]): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  let chars = 0;
  for (const text of texts) {
    if (
      current.length > 0 &&
      (current.length >= OPENAI_EMBEDDING_BATCH_LIMIT ||
        chars + text.length > OPENAI_EMBEDDING_MAX_CHARS_PER_REQUEST)
    ) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(text);
    chars += text.length;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** Cost of embedding `tokens` tokens, rounded up so metering never understates. */
export function embeddingCostMicros(tokens: number): number {
  return Math.ceil((tokens * EMBEDDING_MODEL.costMicrosPerMillion) / 1_000_000);
}

/** Creates an OpenAI Embeddings API client backed by the given API key. */
export function openAIEmbedder(options: OpenAIEmbedderOptions): Embedder {
  const model = options.model ?? EMBEDDING_MODEL.id;
  const dimensions = options.dimensions ?? EMBEDDING_MODEL.dimensions;
  const doFetch = options.fetchImpl ?? fetch;

  return {
    dimensions,
    async embed(texts, onBilled) {
      if (texts.length === 0) return { vectors: [] };

      const out: number[][] = [];
      for (const batch of requestBatches(texts)) {
        let response: Response;
        try {
          response = await doFetch(OPENAI_EMBEDDINGS_URL, {
            method: "POST",
            headers: {
              authorization: `Bearer ${options.apiKey}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              model,
              input: batch,
            }),
          });
        } catch (err) {
          throw toProviderError(err, "openai embeddings request failed");
        }

        if (!response.ok) {
          throw new ProviderError(
            `openai embeddings request failed with ${response.status}`,
            isRetryableStatus(response.status),
            response.status,
          );
        }

        let payload: OpenAIEmbeddingResponse;
        try {
          payload = (await response.json()) as OpenAIEmbeddingResponse;
        } catch (err) {
          throw toProviderError(err, "openai embeddings response was not valid JSON");
        }

        // Reported before the payload is validated: a malformed body was
        // still billed, and so was this request if a later one fails.
        const billed = payload.usage?.total_tokens ?? payload.usage?.prompt_tokens;
        if (typeof billed === "number" && Number.isFinite(billed) && billed > 0) {
          await onBilled(billed);
        }

        if (!Array.isArray(payload.data) || payload.data.length !== batch.length) {
          throw new ProviderError("openai embeddings response length mismatch", true);
        }

        const ordered: Array<number[] | undefined> = new Array(batch.length);
        for (const item of payload.data) {
          if (
            typeof item.index !== "number" ||
            item.index < 0 ||
            item.index >= batch.length ||
            !Array.isArray(item.embedding)
          ) {
            throw new ProviderError("openai embeddings response item malformed", true);
          }
          ordered[item.index] = item.embedding;
        }

        for (const vector of ordered) {
          if (vector === undefined) {
            throw new ProviderError("openai embeddings response missing index", true);
          }
          out.push(vector);
        }
      }

      return { vectors: out };
    },
  };
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
