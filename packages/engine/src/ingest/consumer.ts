import { newId } from "@solvchat/core";
import { forIngestScope } from "../db/tenant.js";
import type { Embedder, Retriever } from "../providers/retrieval.js";
import { chunkMarkdown } from "./chunk.js";
import { documentObjectKey, type IngestQueueMessage } from "./documents.js";

export interface IngestConsumerDeps {
  db: D1Database;
  docs: Pick<R2Bucket, "get" | "delete">;
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

async function cleanupStaleVectors(
  tenant: ReturnType<typeof forIngestScope>,
  retriever: Retriever,
  documentId: string,
): Promise<void> {
  const staleIds = await tenant.documents.listStaleVectors(documentId);
  if (staleIds.length === 0) return;
  const liveIds = new Set((await tenant.documents.listChunks(documentId)).map((c) => c.id));
  const toRemove = staleIds.filter((id) => !liveIds.has(id));
  if (toRemove.length > 0) {
    await retriever.remove(toRemove);
  }
  await tenant.documents.clearStaleVectors(documentId, staleIds);
}

async function persistObsoleteVectorsOnFailure(
  tenant: ReturnType<typeof forIngestScope>,
  documentId: string,
  targetRevision: number,
  expectedGeneration: number,
  chunkIds: string[],
): Promise<void> {
  if (chunkIds.length === 0) return;
  try {
    const latest = await tenant.documents.get(documentId);
    if (
      latest === null ||
      latest.deleting ||
      latest.revision !== targetRevision ||
      latest.chunkGeneration !== expectedGeneration
    ) {
      await tenant.documents.addStaleVectors(documentId, chunkIds);
    }
  } catch {
    // Best-effort durable recording; the original error is rethrown so the
    // message is retried.
  }
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

    const reconcileDeletedDocument = async (): Promise<void> => {
      const [pendingIds, staleIds, staleObjectKeys] = await Promise.all([
        tenant.documents.listAllPendingVectors(documentId),
        tenant.documents.listStaleVectors(documentId),
        tenant.documents.listStaleObjects(documentId),
      ]);
      const cleanupIds = [...new Set([...pendingIds, ...staleIds])];
      if (cleanupIds.length > 0) {
        await deps.retriever.remove(cleanupIds);
      }
      for (const objectKey of staleObjectKeys) {
        await deps.docs.delete(objectKey);
      }
      await Promise.all([
        tenant.documents.clearAllPendingVectors(documentId),
        tenant.documents.clearStaleVectors(documentId, staleIds),
        tenant.documents.clearStaleObjects(documentId, staleObjectKeys),
      ]);
    };

    const document = await tenant.documents.get(documentId);
    if (document === null || document.deleting) {
      // Deleted or deleting: reconcile any remaining vector obligations and ack.
      await reconcileDeletedDocument();
      message.ack();
      continue;
    }

    const source = await tenant.sources.get(document.sourceId);
    if (source === null) {
      message.ack();
      continue;
    }

    if (messageRevision !== undefined && document.revision !== messageRevision) {
      // Superseded by a newer revision: reconcile any pending vectors for this
      // revision as well as durable stale-vector obligations before discarding.
      const [supersededPending, staleIds] = await Promise.all([
        tenant.documents.listPendingVectors(document.id, messageRevision),
        tenant.documents.listStaleVectors(document.id),
      ]);
      const cleanupIds = [...new Set([...supersededPending, ...staleIds])];
      if (cleanupIds.length > 0) {
        await deps.retriever.remove(cleanupIds);
      }
      await Promise.all([
        tenant.documents.clearPendingVectors(document.id, messageRevision),
        tenant.documents.clearStaleVectors(document.id, staleIds),
      ]);
      message.ack();
      continue;
    }

    const targetRevision = messageRevision ?? document.revision;
    const allowSameRevision = messageRevision === undefined;
    const expectedGeneration = document.chunkGeneration;

    if (messageRevision !== undefined && document.indexedRevision >= messageRevision) {
      // Already committed to D1 (retry after stale-vector removal failure or
      // duplicate delivery): finish removing stale vectors without re-embedding.
      await cleanupStaleVectors(tenant, deps.retriever, document.id);
      message.ack();
      continue;
    }

    const object = await deps.docs.get(documentObjectKey(orgId, document.id, targetRevision));
    if (object === null) {
      throw new Error(`missing document body for ${document.id} revision ${targetRevision}`);
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

    if (!reusePending && existingPendingIds.length > 0) {
      const liveIds = new Set((await tenant.documents.listChunks(document.id)).map((c) => c.id));
      const obsoletePendingIds = existingPendingIds.filter((id) => !liveIds.has(id));
      if (obsoletePendingIds.length > 0) {
        await deps.retriever.remove(obsoletePendingIds);
      }
      await tenant.documents.clearPendingVectors(document.id, targetRevision);
    }

    const pendingResult = await tenant.documents.savePendingVectors(
      document.id,
      targetRevision,
      chunks.map((chunk) => chunk.id),
      { allowSameRevision, expectedGeneration },
    );
    if (!pendingResult.ok) {
      const latest = await tenant.documents.get(document.id);
      if (latest === null || latest.deleting) {
        await reconcileDeletedDocument();
      } else if (messageRevision !== undefined && latest.revision !== targetRevision) {
        const [supersededPending, staleIds, liveChunks] = await Promise.all([
          tenant.documents.listPendingVectors(document.id, targetRevision),
          tenant.documents.listStaleVectors(document.id),
          tenant.documents.listChunks(document.id),
        ]);
        const liveIds = new Set(liveChunks.map((c) => c.id));
        const cleanupIds = [...new Set([...supersededPending, ...staleIds])].filter(
          (id) => !liveIds.has(id),
        );
        if (cleanupIds.length > 0) {
          await deps.retriever.remove(cleanupIds);
        }
        await Promise.all([
          tenant.documents.clearPendingVectors(document.id, targetRevision),
          tenant.documents.clearStaleVectors(document.id, staleIds),
        ]);
      } else {
        await cleanupStaleVectors(tenant, deps.retriever, document.id);
      }
      message.ack();
      continue;
    }

    // Adopt the canonical pending IDs so concurrent attempts for the same
    // revision upsert and reference the exact same vector IDs.
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const canonicalId = pendingResult.chunkIds[i];
      if (chunk && canonicalId !== undefined) {
        chunk.id = canonicalId;
      }
    }

    const chunkIds = chunks.map((chunk) => chunk.id);
    if (chunks.length > 0) {
      try {
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
      } catch (err) {
        await persistObsoleteVectorsOnFailure(
          tenant,
          document.id,
          targetRevision,
          expectedGeneration,
          chunkIds,
        );
        throw err;
      }
    }

    let committed: boolean;
    try {
      committed = await tenant.documents.replaceChunks(document.id, chunks, targetRevision, {
        allowSameRevision,
        expectedGeneration,
      });
    } catch (err) {
      await persistObsoleteVectorsOnFailure(
        tenant,
        document.id,
        targetRevision,
        expectedGeneration,
        chunkIds,
      );
      throw err;
    }

    if (!committed) {
      const latest = await tenant.documents.get(document.id);
      if (latest !== null && !latest.deleting && latest.revision === targetRevision) {
        // Another consumer already committed this revision (or a newer
        // generation of the same revision): keep any live vectors intact and
        // remove only our obsolete vectors plus remaining stale-vector cleanup.
        const liveIds = new Set((await tenant.documents.listChunks(document.id)).map((c) => c.id));
        const obsoleteIds = chunkIds.filter((id) => !liveIds.has(id));
        if (obsoleteIds.length > 0) {
          try {
            await deps.retriever.remove(obsoleteIds);
          } catch (err) {
            await tenant.documents.addStaleVectors(document.id, obsoleteIds);
            throw err;
          }
        }
        await cleanupStaleVectors(tenant, deps.retriever, document.id);
        message.ack();
        continue;
      }

      // Superseded or deleting: remove the vectors we just upserted, retaining
      // durable stale records if removal fails so retries can reconcile them.
      if (chunkIds.length > 0) {
        try {
          await deps.retriever.remove(chunkIds);
        } catch (err) {
          await tenant.documents.addStaleVectors(document.id, chunkIds);
          throw err;
        }
      }
      await tenant.documents.clearPendingVectors(document.id, targetRevision);
      if (latest === null || latest.deleting) {
        await reconcileDeletedDocument();
      } else {
        await cleanupStaleVectors(tenant, deps.retriever, document.id);
      }
      message.ack();
      continue;
    }

    await cleanupStaleVectors(tenant, deps.retriever, document.id);
    message.ack();
  }
}
