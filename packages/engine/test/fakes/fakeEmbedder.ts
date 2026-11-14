import { EMBEDDING_MODEL } from "../../src/models.js";
import type { Embedder } from "../../src/providers/retrieval.js";

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0 || 1;
}

function hashVector(text: string, dimensions: number): number[] {
  let state = fnv1a(text);
  const raw = new Array<number>(dimensions);
  let normSq = 0;

  for (let i = 0; i < dimensions; i++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    // Map unsigned 32-bit int to [-1, 1].
    const value = (state >>> 0) / 0x7fffffff - 1;
    raw[i] = value;
    normSq += value * value;
  }

  const norm = Math.sqrt(normSq) || 1;
  return raw.map((v) => v / norm);
}

/** Deterministic hash-based `Embedder` for tests; makes no network calls. */
export function fakeEmbedder(dimensions: number = EMBEDDING_MODEL.dimensions): Embedder {
  return {
    dimensions,
    async embed(texts) {
      // A rough, deterministic token count so metering paths have something
      // to record.
      const tokens = texts.reduce((sum, text) => sum + Math.ceil(text.length / 4), 0);
      return { vectors: texts.map((text) => hashVector(text, dimensions)), tokens };
    },
  };
}
