import type { Retriever, VectorRecord } from "../../src/providers/retrieval.js";
import { type MemoryRetriever, memoryRetriever } from "./memoryRetriever.js";

export interface LaggingRetriever extends Retriever {
  /** Applies every write made so far, in the order it was made, as the index would. */
  catchUp(): Promise<void>;
  /** Writes made but not yet visible to queries. */
  pending(): number;
  /** The vectors queries see now. */
  all(): VectorRecord[];
  /** The filters and `topK` of every query, in order. */
  readonly queries: Array<{ orgId: string; assistantId: string; topK: number }>;
}

/**
 * A `Retriever` that, like Vectorize, takes writes at once and shows them to
 * queries only later: upserts and deletes wait until `catchUp`, and are then
 * applied in the order they were made ("All changes before this mutation
 * will be reflected in the index state").
 */
export function laggingRetriever(): LaggingRetriever {
  const index: MemoryRetriever = memoryRetriever();
  const log: Array<() => Promise<void>> = [];
  const queries: LaggingRetriever["queries"] = [];
  return {
    queries,
    async upsert(vectors) {
      const copy = vectors.map((v) => ({ ...v, vector: [...v.vector] }));
      log.push(() => index.upsert(copy));
    },
    async remove(chunkIds) {
      const copy = [...chunkIds];
      log.push(() => index.remove(copy));
    },
    async query(args) {
      queries.push({ orgId: args.orgId, assistantId: args.assistantId, topK: args.topK });
      return index.query(args);
    },
    async catchUp() {
      for (const apply of log.splice(0)) await apply();
    },
    pending: () => log.length,
    all: () => index.all(),
  };
}
