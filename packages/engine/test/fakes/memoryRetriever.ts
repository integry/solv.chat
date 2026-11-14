import type { Retriever, VectorRecord } from "../../src/providers/retrieval.js";

function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export interface MemoryRetriever extends Retriever {
  /** Snapshot of all stored records for test assertions. */
  all(): VectorRecord[];
}

/**
 * In-memory `Retriever` using cosine similarity and the same `orgId` +
 * `assistantId` metadata filtering as `VectorizeRetriever`.
 */
export function memoryRetriever(): MemoryRetriever {
  const store = new Map<string, VectorRecord>();

  return {
    async upsert(vectors) {
      for (const record of vectors) {
        store.set(record.chunkId, {
          chunkId: record.chunkId,
          vector: [...record.vector],
          orgId: record.orgId,
          assistantId: record.assistantId,
        });
      }
    },

    async query({ vector, orgId, assistantId, topK }) {
      const scored: Array<{ chunkId: string; score: number }> = [];
      for (const record of store.values()) {
        if (record.orgId !== orgId || record.assistantId !== assistantId) {
          continue;
        }
        scored.push({
          chunkId: record.chunkId,
          score: cosineSimilarity(vector, record.vector),
        });
      }
      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, Math.max(0, topK));
    },

    async remove(chunkIds) {
      for (const id of chunkIds) {
        store.delete(id);
      }
    },

    all() {
      return [...store.values()];
    },
  };
}
