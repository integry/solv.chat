import { newId } from "@solvchat/core";
import { forQueuedIngest } from "../db/tenant.js";
import { type Embedder, embeddingCostMicros, type Retriever } from "../providers/retrieval.js";
import type { UsageSink } from "../seams/types.js";
import { chunkMarkdown } from "./chunk.js";
import type { IngestQueueMessage } from "./documents.js";

export interface IngestConsumerDeps {
  db: D1Database;
  docs: Pick<R2Bucket, "get">;
  embedder: Embedder;
  retriever: Retriever;
  /** Receives the embedding spend; the open build writes it to `usage_daily`. */
  usage?: UsageSink | undefined;
  /**
   * Asks the auth seam which org a message's claimed `orgId` belongs to
   * (`AuthProvider.resolveOrg` with `queued_ingest`); null drops the message.
   */
  resolveOrg: (claimedOrgId: string) => Promise<string | null>;
}

/**
 * The text a chunk is embedded as: its heading path, then its body.
 *
 * The chunker moves headings out of `text` into `headingPath`, so embedding
 * the body alone would drop the subject a section is about — and for a
 * hand-written entry the heading *is* the question. The path is short (a few
 * headings), so this stays well inside the embedding model's input limit.
 */
export function embeddingInput(chunk: { headingPath: string; text: string }): string {
  return chunk.headingPath === "" ? chunk.text : `${chunk.headingPath}\n\n${chunk.text}`;
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

async function processIngestMessage(
  message: Message<unknown>,
  deps: IngestConsumerDeps,
): Promise<void> {
  if (!isIngestMessage(message.body)) {
    message.ack();
    return;
  }

  const { documentId, contentHash } = message.body;
  const orgId = await deps.resolveOrg(message.body.orgId);
  if (orgId === null) {
    message.ack();
    return;
  }
  const tenant = forQueuedIngest(deps.db, orgId);

  const document = await tenant.documents.get(documentId);
  if (document === null || document.contentHash !== contentHash) {
    message.ack();
    return;
  }

  if (document.indexedHash === contentHash) {
    message.ack();
    return;
  }

  const source = await tenant.sources.get(document.sourceId);
  if (source === null) {
    message.ack();
    return;
  }

  const object = document.bodyKey !== null ? await deps.docs.get(document.bodyKey) : null;
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

  let vectors: number[][] = [];
  if (chunks.length > 0) {
    // Metered per provider request, as soon as each one is billed: when a
    // later request or the upsert fails, the message retries and pays again
    // for the requests that succeeded, and the owner's figure should say so.
    const assistantId = source.assistantId;
    const embedded = await deps.embedder.embed(chunks.map(embeddingInput), async (tokens) => {
      await deps.usage?.record({
        orgId,
        assistantId,
        at: Date.now(),
        messages: 0,
        tokensIn: 0,
        tokensOut: 0,
        costMicros: embeddingCostMicros(tokens),
      });
    });
    vectors = embedded.vectors;
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
    return;
  }

  if (previousChunkIds.length > 0) {
    await bestEffort("ingest consumer: best-effort stale vector cleanup failed", document.id, () =>
      deps.retriever.remove(previousChunkIds),
    );
  }
  message.ack();
}

/**
 * Processes an ingest Queue batch idempotently on `(documentId, contentHash)`:
 * checks D1 state, reads the R2 body from `document.bodyKey`, chunks with fresh
 * ids, embeds, upserts vectors, commits in one guarded D1 batch, and performs
 * best-effort cleanup of superseded vectors. Each message is isolated so one
 * failure retries only that message without failing its neighbours.
 */
export async function runIngestBatch(
  batch: Pick<MessageBatch<unknown>, "messages">,
  deps: IngestConsumerDeps,
): Promise<void> {
  for (const message of batch.messages) {
    try {
      await processIngestMessage(message, deps);
    } catch (err) {
      console.warn("ingest consumer: message failed, scheduling retry", {
        messageId: message.id,
        error: err instanceof Error ? err.message : String(err),
      });
      message.retry();
    }
  }
}
