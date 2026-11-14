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
  return (
    typeof record.documentId === "string" &&
    record.documentId !== "" &&
    typeof record.orgId === "string" &&
    record.orgId !== "" &&
    typeof record.contentHash === "string" &&
    record.contentHash !== ""
  );
}

async function bestEffort(
  label: string,
  documentId: string,
  fn: () => Promise<unknown>,
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    console.warn(label, {
      documentId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Processes an ingest Queue batch idempotently on `(documentId, contentHash)`:
 * checks D1 state, reads the content-addressed R2 body, chunks with fresh ids,
 * embeds, upserts vectors, commits in one guarded D1 batch, and performs
 * best-effort cleanup of unused vectors and R2 objects.
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

    const { orgId, documentId, contentHash } = message.body;
    const tenant = forIngestScope(deps.db, { orgId, assistantId: "" });

    const document = await tenant.documents.get(documentId);
    if (document === null || document.contentHash !== contentHash) {
      await bestEffort("ingest consumer: best-effort R2 cleanup failed", documentId, () =>
        deps.docs.delete(documentObjectKey(orgId, documentId, contentHash)),
      );
      message.ack();
      continue;
    }

    if (document.indexedHash === contentHash) {
      message.ack();
      continue;
    }

    const source = await tenant.sources.get(document.sourceId);
    if (source === null) {
      message.ack();
      continue;
    }

    const object = await deps.docs.get(documentObjectKey(orgId, document.id, contentHash));
    if (object === null) {
      throw new Error(`missing document body for ${document.id}`);
    }

    const markdown = await object.text();
    const chunks = chunkMarkdown(markdown).map((chunk) => ({
      id: newId("chk"),
      ordinal: chunk.ordinal,
      text: chunk.text,
      headingPath: chunk.headingPath.join(" > "),
    }));

    const vectors =
      chunks.length > 0 ? await deps.embedder.embed(chunks.map((chunk) => chunk.text)) : [];

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

    const previousChunkIds = (await tenant.documents.listChunks(document.id)).map((c) => c.id);
    const committed = await tenant.documents.replaceChunks(document.id, chunks, contentHash);
    const newChunkIds = chunks.map((c) => c.id);

    if (!committed) {
      if (newChunkIds.length > 0) {
        await bestEffort("ingest consumer: best-effort vector cleanup failed", document.id, () =>
          deps.retriever.remove(newChunkIds),
        );
      }
      message.ack();
      continue;
    }

    if (previousChunkIds.length > 0) {
      await bestEffort(
        "ingest consumer: best-effort stale vector cleanup failed",
        document.id,
        () => deps.retriever.remove(previousChunkIds),
      );
    }
    if (document.indexedHash !== null && document.indexedHash !== contentHash) {
      const staleObjectKey = documentObjectKey(orgId, document.id, document.indexedHash);
      await bestEffort("ingest consumer: best-effort stale R2 cleanup failed", document.id, () =>
        deps.docs.delete(staleObjectKey),
      );
    }
    message.ack();
  }
}
