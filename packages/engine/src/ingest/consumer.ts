import { newId } from "@solvchat/core";
import type { DocumentRow, IndexErrorCode } from "../db/documents.js";
import { forQueuedIngest, type Tenant } from "../db/tenant.js";
import { type Embedder, embeddingCostMicros, type Retriever } from "../providers/retrieval.js";
import type { UsageSink } from "../seams/types.js";
import { chunkMarkdown, exceedsChunkBudget, joinHeadingPath } from "./chunk.js";
import type { IngestQueueMessage } from "./documents.js";
import { INGEST_VERSION } from "./version.js";

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
 * How much heading context a chunk's embedding input may carry: at most this
 * many characters of heading path per character of body, so the path is at
 * most a third of the input.
 *
 * The chunker moves headings out of `text` into `headingPath`, so embedding
 * the body alone would drop the subject a section is about. But the path
 * starts with the page's own title, which every chunk of the page shares:
 * left unbounded, a 47-character footer list under "Test your MCP server
 * online > Guides" was mostly title, and scored like the page's best answer
 * for any question about testing an MCP server (issue #123). Bounding the
 * share means the body always carries the vector: an empty or near-empty
 * chunk gets almost no heading at all, so it cannot score on its title, and
 * a full chunk (1200 characters) still gets its whole path. When the path is
 * too long, its broadest headings go first (the page title, then the next),
 * because the narrowest one says most about this chunk and least about its
 * neighbours.
 */
export const MAX_HEADING_SHARE = 0.5;

/**
 * The text a chunk is embedded as: its heading path (bounded, see
 * `MAX_HEADING_SHARE`), then its body. `headingIsContent` lifts the bound
 * for a written answer, whose heading is the owner's question: owner-written
 * content, not a page's title, and the very words a visitor asks; and for
 * a document that is a single chunk, whose headings no other chunk shares.
 */
export function embeddingInput(
  chunk: { headingPath: string; text: string },
  options: { headingIsContent?: boolean | undefined } = {},
): string {
  const context =
    options.headingIsContent === true
      ? chunk.headingPath
      : boundedHeadingPath(chunk.headingPath, Math.floor(chunk.text.length * MAX_HEADING_SHARE));
  return context === "" ? chunk.text : `${context}\n\n${chunk.text}`;
}

/** The narrowest headings of `path` (joined with " > ") that fit in `budget` characters. */
export function boundedHeadingPath(path: string, budget: number): string {
  if (path.length <= budget) return path;
  const headings = path.split(" > ");
  while (headings.length > 0 && headings.join(" > ").length > budget) headings.shift();
  return headings.join(" > ");
}

/** A chunk ready to store, with the text its vector is made from. */
interface IndexedChunk {
  id: string;
  ordinal: number;
  text: string;
  headingPath: string;
  embedText: string;
}

/**
 * The chunks to store for a document. A written answer (an `entry`) also
 * gets one chunk embedded as its question alone, holding the same text as
 * its first chunk: a visitor who asks the owner's question in the owner's
 * words then matches it almost exactly, however long the answer is, where
 * the question would be diluted in a vector of the whole answer. Selection
 * keeps one of the two (they are duplicates; see `selectChunks`).
 */
export function chunksToIndex(
  markdown: string,
  document: { title: string },
  sourceKind: "push" | "sitemap" | "entry",
): IndexedChunk[] {
  const entry = sourceKind === "entry";
  const parts = chunkMarkdown(markdown);
  // A document that is one chunk has nothing to share its headings with:
  // its title is its subject, not a label repeated over its other chunks
  // ("# How long is the refund window?" over "30 days."), so it keeps them.
  const headingIsContent = entry || parts.length === 1;
  const chunks: IndexedChunk[] = parts.map((chunk) => {
    const headingPath = joinHeadingPath(chunk.headingPath);
    return {
      id: newId("chk"),
      ordinal: chunk.ordinal,
      text: chunk.text,
      headingPath,
      embedText: embeddingInput({ headingPath, text: chunk.text }, { headingIsContent }),
    };
  });
  const [first] = chunks;
  const question = document.title.trim();
  if (entry && first !== undefined && question !== "") {
    chunks.push({
      id: newId("chk"),
      ordinal: chunks.length,
      text: first.text,
      headingPath: first.headingPath,
      embedText: question,
    });
  }
  return chunks;
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

  // Indexed, and by the current pipeline. A document indexed by an older
  // version is rebuilt from its stored text (a re-index; see
  // `ingest/version.ts`), once: the commit records the version.
  if (document.indexedHash === contentHash && document.ingestVersion >= INGEST_VERSION) {
    message.ack();
    return;
  }

  const source = await tenant.sources.get(document.sourceId);
  if (source === null) {
    message.ack();
    return;
  }

  try {
    await indexDocument(message, deps, tenant, document, source, orgId);
  } catch (err) {
    // Recorded on every failed attempt, so the admin shows "Failed" rather
    // than "Indexing…" while the Queue retries; a later success marks the
    // content indexed and the error no longer applies. Only a code is stored.
    const code: IndexErrorCode =
      err instanceof MissingBodyError ? "missing_body" : "embedding_failed";
    await bestEffort("ingest consumer: could not record index error", document.id, () =>
      tenant.documents.markIndexError(document.id, contentHash, code),
    );
    throw err;
  }
}

class MissingBodyError extends Error {}

async function indexDocument(
  message: Message<unknown>,
  deps: IngestConsumerDeps,
  tenant: Tenant,
  document: DocumentRow,
  source: { assistantId: string; kind: "push" | "sitemap" | "entry" },
  orgId: string,
): Promise<void> {
  const { assistantId } = source;
  const contentHash = document.contentHash;
  const object = document.bodyKey !== null ? await deps.docs.get(document.bodyKey) : null;
  if (object === null) {
    throw new MissingBodyError(`missing document body for ${document.id}`);
  }

  const markdown = await object.text();
  const parts = chunkMarkdown(markdown);
  if (exceedsChunkBudget(parts)) {
    // `pushDocuments` refuses such a document, so only a body stored before
    // that check (or a chunker change) reaches here. Nothing is committed and
    // the hash is not marked indexed, so the document never looks complete;
    // retrying would give the same answer, so the message is not retried.
    console.error("ingest consumer: document has too many sections to index", {
      documentId: document.id,
      externalId: document.externalId,
      chunks: parts.length,
    });
    await bestEffort("ingest consumer: could not record index error", document.id, () =>
      tenant.documents.markIndexError(document.id, contentHash, "too_long"),
    );
    message.ack();
    return;
  }
  const chunks = chunksToIndex(markdown, document, source.kind);

  let vectors: number[][] = [];
  if (chunks.length > 0) {
    // Metered per provider request, as soon as each one is billed: when a
    // later request or the upsert fails, the message retries and pays again
    // for the requests that succeeded, and the owner's figure should say so.
    const embedded = await deps.embedder.embed(
      chunks.map((chunk) => chunk.embedText),
      async (tokens) => {
        await deps.usage?.record({
          orgId,
          assistantId,
          at: Date.now(),
          messages: 0,
          tokensIn: 0,
          tokensOut: 0,
          costMicros: embeddingCostMicros(tokens),
        });
      },
    );
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
          assistantId,
        };
      }),
    );
  }

  const previousChunkIds = (await tenant.documents.listChunks(document.id)).map((c) => c.id);
  const committed = await tenant.documents.replaceChunks(
    document.id,
    chunks.map(({ id, ordinal, text, headingPath }) => ({ id, ordinal, text, headingPath })),
    contentHash,
    INGEST_VERSION,
  );
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
