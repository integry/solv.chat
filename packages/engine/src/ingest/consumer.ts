import { newId } from "@solvchat/core";
import { forIngestScope } from "../db/tenant.js";
import type { Embedder, Retriever } from "../providers/retrieval.js";
import { chunkMarkdown } from "./chunk.js";
import { documentObjectKey, type IngestQueueMessage } from "./documents.js";

export interface IngestConsumerDeps {
  db: D1Database;
  docs: Pick<R2Bucket, "get">;
  embedder: Embedder;
  retriever: Retriever;
}

function isIngestMessage(body: unknown): body is IngestQueueMessage {
  return (
    typeof body === "object" &&
    body !== null &&
    typeof (body as Record<string, unknown>).documentId === "string" &&
    typeof (body as Record<string, unknown>).orgId === "string"
  );
}

/**
 * Processes an ingest Queue batch: loads each document and its R2 body,
 * chunks, embeds, upserts vectors, replaces D1 chunk rows, and removes stale
 * vectors. Any failure throws before chunk rows are replaced so Queue retries
 * leave the previous chunks intact.
 */
export async function runIngestBatch(
  batch: Pick<MessageBatch<unknown>, "messages">,
  deps: IngestConsumerDeps,
): Promise<void> {
  for (const message of batch.messages) {
    if (!isIngestMessage(message.body)) {
      message.ack();
      continue;
    }

    const { documentId, orgId } = message.body;
    const tenant = forIngestScope(deps.db, { orgId, assistantId: "" });
    const document = await tenant.documents.get(documentId);
    if (document === null) {
      // Deleted between the push and now: acknowledge so it is not retried.
      message.ack();
      continue;
    }

    const source = await tenant.sources.get(document.sourceId);
    if (source === null) {
      message.ack();
      continue;
    }

    const object = await deps.docs.get(documentObjectKey(orgId, document.id));
    if (object === null) {
      throw new Error(`missing document body for ${document.id}`);
    }

    const markdown = await object.text();
    const rawChunks = chunkMarkdown(markdown);
    const chunks = rawChunks.map((chunk) => ({
      id: newId("chk"),
      ordinal: chunk.ordinal,
      text: chunk.text,
      headingPath: chunk.headingPath.join(" > "),
    }));

    // Embed before touching D1 or Vectorize so a provider failure leaves the
    // previous good chunks and vectors intact.
    const vectors =
      chunks.length > 0 ? await deps.embedder.embed(chunks.map((chunk) => chunk.text)) : [];

    const existingChunks = await tenant.documents.listChunks(document.id);
    const staleIds = existingChunks.map((chunk) => chunk.id);

    await deps.retriever.upsert(
      chunks.map((chunk, index) => {
        const vector = vectors[index];
        if (vector === undefined) {
          throw new Error(`missing embedding vector at index ${index}`);
        }
        return {
          chunkId: chunk.id,
          vector,
          orgId,
          assistantId: source.assistantId,
        };
      }),
    );

    await tenant.documents.replaceChunks(document.id, chunks);
    await deps.retriever.remove(staleIds);
    message.ack();
  }
}
