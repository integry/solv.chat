import { EMBEDDING_MODEL } from "../models.js";
import { isRetryableStatus, ProviderError, toProviderError } from "./error.js";

// Source: https://platform.openai.com/docs/api-reference/embeddings/create — checked 2026-11-14
const OPENAI_EMBEDDINGS_URL = "https://api.openai.com/v1/embeddings";

// Source: https://platform.openai.com/docs/api-reference/embeddings/create — checked 2026-11-14
// OpenAI's embeddings endpoint accepts up to 2,048 inputs per request.
export const OPENAI_EMBEDDING_BATCH_LIMIT = 2048;

export interface Embedder {
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
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
}

/** Creates an OpenAI Embeddings API client backed by the given API key. */
export function openAIEmbedder(options: OpenAIEmbedderOptions): Embedder {
  const model = options.model ?? EMBEDDING_MODEL.id;
  const dimensions = options.dimensions ?? EMBEDDING_MODEL.dimensions;
  const doFetch = options.fetchImpl ?? fetch;

  return {
    dimensions,
    async embed(texts) {
      if (texts.length === 0) return [];

      const out: number[][] = [];
      for (let offset = 0; offset < texts.length; offset += OPENAI_EMBEDDING_BATCH_LIMIT) {
        const batch = texts.slice(offset, offset + OPENAI_EMBEDDING_BATCH_LIMIT);
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

      return out;
    },
  };
}

/** Vectorize-backed `Retriever` that always filters by `org_id` and `assistant_id`. */
export function vectorizeRetriever(index: VectorizeIndex): Retriever {
  return {
    async upsert(vectors) {
      if (vectors.length === 0) return;
      await index.upsert(
        vectors.map((record) => ({
          id: record.chunkId,
          values: record.vector,
          metadata: {
            org_id: record.orgId,
            assistant_id: record.assistantId,
          },
        })),
      );
    },

    async query({ vector, orgId, assistantId, topK }) {
      const result = await index.query(vector, {
        topK,
        filter: {
          org_id: orgId,
          assistant_id: assistantId,
        },
        returnMetadata: "none",
      });
      return result.matches.map((match) => ({
        chunkId: match.id,
        score: match.score,
      }));
    },

    async remove(chunkIds) {
      if (chunkIds.length === 0) return;
      await index.deleteByIds(chunkIds);
    },
  };
}
