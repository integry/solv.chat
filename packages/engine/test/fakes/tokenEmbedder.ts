import { EMBEDDING_MODEL } from "../../src/models.js";
import type { Embedder } from "../../src/providers/retrieval.js";

// Words that say nothing about a subject; left in, every English sentence
// would overlap every question a little.
const STOPWORDS = new Set(
  "a an and are as at be by can do does for from has have how i if in is it its of on or so that the this to vs was we what when where which who why will with you your".split(
    " ",
  ),
);

/** The subject words of a text, lowercased, without stopwords. */
export function tokensOf(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => !STOPWORDS.has(w));
}

function dimensionOf(token: string, dimensions: number): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % dimensions;
}

/**
 * A deterministic `Embedder` whose cosine similarity reflects word overlap:
 * each subject word adds one to its own dimension, and the vector is
 * normalised. Two texts score by how much of their wording they share,
 * weighted by how much of each text that wording is, which is the property
 * that let a short chunk under a matching title outscore a long one that
 * holds the answer (issue #123). No network.
 */
export function tokenEmbedder(dimensions: number = EMBEDDING_MODEL.dimensions): Embedder {
  return {
    dimensions,
    async embed(texts, onBilled) {
      const tokens = texts.reduce((sum, text) => sum + Math.ceil(text.length / 4), 0);
      if (tokens > 0) await onBilled(tokens);
      return {
        vectors: texts.map((text) => {
          const vector = new Array<number>(dimensions).fill(0);
          for (const token of tokensOf(text)) {
            const i = dimensionOf(token, dimensions);
            vector[i] = (vector[i] ?? 0) + 1;
          }
          const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0)) || 1;
          return vector.map((v) => v / norm);
        }),
      };
    },
  };
}
