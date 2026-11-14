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
  if (typeof body !== "object" || body === null) return false;
  const record = body as Record<string, unknown>;
  if (typeof record.documentId !== "string" || typeof record.orgId !== "string") {
    return false;
  }
  return (
    record.revision === undefined ||
    (typeof record.revision === "number" && Number.isInteger(record.revision))
  );
}

/**
 * Processes an ingest Queue batch: loads each document and its R2 body,
 * chunks, embeds, durably tracks pending/stale vector IDs, upserts vectors,
 * atomically replaces D1 chunk rows if the revision is still current, and
 * removes stale vectors.
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

    const { documentId, orgId, revision: messageRevision } = message.body;
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

    if (messageRevision !== undefined && document.revision !== messageRevision) {
      // Superseded by a newer revision: clean up any pending vectors from an
      // earlier failed attempt of this revision and discard.
      const supersededPending = await tenant.documents.listPendingVectors(
        document.id,
        messageRevision,
      );
      if (supersededPending.length > 0) {
        await deps.retriever.remove(supersededPending);
        await tenant.documents.clearPendingVectors(document.id, messageRevision);
      }
      message.ack();
      continue;
    }

    const targetRevision = messageRevision ?? document.revision;

    if (messageRevision !== undefined && document.indexedRevision === messageRevision) {
      // Already committed to D1 (retry after stale-vector removal failure):
      // finish removing stale vectors without re-embedding.
      const staleIds = await tenant.documents.listStaleVectors(document.id);
      if (staleIds.length > 0) {
        await deps.retriever.remove(staleIds);
        await tenant.documents.clearStaleVectors(document.id, staleIds);
      }
      message.ack();
      continue;
    }

    const object = await deps.docs.get(documentObjectKey(orgId, document.id));
    if (object === null) {
      throw new Error(`missing document body for ${document.id}`);
    }

    const markdown = await object.text();
    const rawChunks = chunkMarkdown(markdown);

    const existingPendingIds = await tenant.documents.listPendingVectors(
      document.id,
      targetRevision,
    );
    const reusePending = existingPendingIds.length === rawChunks.length;
    const chunks = rawChunks.map((chunk, index) => ({
      id: reusePending ? (existingPendingIds[index] as string) : newId("chk"),
      ordinal: chunk.ordinal,
      text: chunk.text,
      headingPath: chunk.headingPath.join(" > "),
    }));

    // Embed before touching D1 or Vectorize so a provider failure leaves the
    // previous good chunks and vectors intact.
    const vectors =
      chunks.length > 0 ? await deps.embedder.embed(chunks.map((chunk) => chunk.text)) : [];

    if (!reusePending) {
      if (existingPendingIds.length > 0) {
        await deps.retriever.remove(existingPendingIds);
        await tenant.documents.clearPendingVectors(document.id, targetRevision);
      }
      const stillCurrent = await tenant.documents.savePendingVectors(
        document.id,
        targetRevision,
        chunks.map((chunk) => chunk.id),
      );
      if (!stillCurrent) {
        message.ack();
        continue;
      }
    } else {
      const latest = await tenant.documents.get(document.id);
      if (latest === null || latest.revision !== targetRevision) {
        if (existingPendingIds.length > 0) {
          await deps.retriever.remove(existingPendingIds);
          await tenant.documents.clearPendingVectors(document.id, targetRevision);
        }
        message.ack();
        continue;
      }
    }

    if (chunks.length > 0) {
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
    }

    const committed = await tenant.documents.replaceChunks(document.id, chunks, targetRevision);
    if (!committed) {
      // Superseded between upsert and replaceChunks: remove the vectors we just
      // upserted, clear our pending record, and acknowledge.
      if (chunks.length > 0) {
        await deps.retriever.remove(chunks.map((chunk) => chunk.id));
      }
      await tenant.documents.clearPendingVectors(document.id, targetRevision);
      message.ack();
      continue;
    }

    const staleIds = await tenant.documents.listStaleVectors(document.id);
    if (staleIds.length > 0) {
      await deps.retriever.remove(staleIds);
      await tenant.documents.clearStaleVectors(document.id, staleIds);
    }
    message.ack();
  }
}
