import {
  type DocumentInput,
  isPlainObject,
  MAX_DOCUMENT_MARKDOWN_BYTES,
  newId,
  parseDocumentInput,
  type SourceKind,
} from "@solvchat/core";
import { BadRequest, NotFound } from "../admin/errors.js";
import type { DocumentRow } from "../db/documents.js";
import type { SourceRow } from "../db/sources.js";
import type { IngestScope, Tenant } from "../db/tenant.js";
import type { Retriever } from "../providers/retrieval.js";
import { sha256Hex } from "../util/crypto.js";
import { chunkMarkdown, exceedsChunkBudget, MAX_CHUNKS } from "./chunk.js";
import { type RepeatedQueue, reconcileAfterRemoval } from "./repeatedSource.js";
import { INGEST_VERSION } from "./version.js";

export const MAX_BATCH_DOCUMENTS = 100;

export class TooLarge extends Error {}

/** A sync page's run no longer held its source when the document was written; nothing was. */
export class SyncRunEnded extends Error {}

export interface SourceOptions {
  /**
   * When set, a `sourceId` in the body must name a source of this kind. The
   * ingest route passes `"push"`: an ingest key with a mistyped `--source-id`
   * must not overwrite or prune hand-written answers or a sitemap import.
   */
  requireKind?: SourceKind | undefined;
  /**
   * A scheduled sync's page: each document row is written only while this
   * run still holds the source, checked in the write itself. Otherwise the
   * new body is deleted again and `SyncRunEnded` is thrown.
   */
  syncRun?: { runId: string; now: () => number } | undefined;
}

export interface IngestCounts {
  written: number;
  unchanged: number;
  deleted: number;
}

export interface IngestQueueMessage {
  orgId: string;
  documentId: string;
  contentHash: string;
}

export interface PushDeps {
  tenant: Tenant;
  docs: {
    put(key: string, value: string): Promise<unknown>;
    delete(key: string): Promise<unknown>;
  };
  queue: { send(message: IngestQueueMessage): Promise<unknown> };
}

export interface DeleteDeps {
  tenant: Tenant;
  docs: { delete(keys: string | string[]): Promise<unknown> };
  retriever: Pick<Retriever, "remove">;
  /**
   * After a removal, the source's repeated blocks are worked out again and
   * the pages whose blocks changed status are queued here, or a retried
   * `repeated_source` message is (see "Repeated blocks"). Left out when the
   * whole source goes.
   */
  repeated?: { queue: RepeatedQueue; orgId: string } | undefined;
}

const encoder = new TextEncoder();

/**
 * SHA-256 of title and body. The title is included because retitling a page
 * is a real change the retriever should see; hashing the body alone would make
 * it a no-op.
 *
 * The pair is JSON-encoded rather than joined with a delimiter: titles may
 * contain newlines, and `"A\nB" + "C"` must not hash like `"A" + "B\nC"`.
 */
export async function contentHash(title: string, markdown: string): Promise<string> {
  return sha256Hex(JSON.stringify([title, markdown]));
}

/** Returns a fresh, never-reused R2 object key for a document's Markdown body. */
export function documentObjectKey(
  orgId: string,
  documentId: string,
  bodyId = crypto.randomUUID(),
): string {
  return `org/${orgId}/doc/${documentId}/${bodyId}.md`;
}

// Source: https://developers.cloudflare.com/r2/api/workers/workers-api-reference/ — checked 2026-11-14
// `delete(key: string | string[])`: "Up to 1000 keys may be deleted per call."
const R2_DELETE_KEYS_LIMIT = 1000;

async function tryDeleteObject(
  docs: { delete(keys: string | string[]): Promise<unknown> },
  keys: string | string[],
  ownerId: string,
): Promise<void> {
  try {
    await docs.delete(keys);
  } catch (err) {
    console.warn("ingest: best-effort R2 delete failed", {
      id: ownerId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// The same bounds the admin uses for a source's label.
const MAX_SOURCE_LABEL_LENGTH = 80;
// The default push source's stored label; the admin shows it as "Your site".
const DEFAULT_PUSH_LABEL = "Push";

/**
 * Reads the optional `source` label of a push or prune. A label names its own
 * push source, so two pushers with different labels never prune each other's
 * documents; without one, the default push source is used, as before.
 */
function readSourceLabel(rawBody: Record<string, unknown>): string | undefined {
  const raw = rawBody.source;
  if (raw === undefined || raw === null) return undefined;
  if (rawBody.sourceId !== undefined && rawBody.sourceId !== null) {
    throw new BadRequest(["source: give sourceId or source, not both"]);
  }
  const label = typeof raw === "string" ? raw.trim() : "";
  if (label.length === 0 || label.length > MAX_SOURCE_LABEL_LENGTH) {
    throw new BadRequest([`source: must be 1 to ${MAX_SOURCE_LABEL_LENGTH} characters`]);
  }
  if (label.toLowerCase() === DEFAULT_PUSH_LABEL.toLowerCase()) {
    throw new BadRequest([
      `source: "${label}" is the default source's name; leave source out to use it`,
    ]);
  }
  return label;
}

async function findExistingSource(
  tenant: Tenant,
  assistantId: string,
  rawBody: Record<string, unknown>,
  options: SourceOptions,
): Promise<SourceRow | null> {
  const sourceId = rawBody.sourceId;
  const label = readSourceLabel(rawBody);
  if (label !== undefined) {
    return tenant.sources.getPushByLabel(assistantId, label);
  }
  if (sourceId !== undefined && sourceId !== null) {
    if (typeof sourceId !== "string" || sourceId.trim() === "") {
      throw new BadRequest(["sourceId: must be a non-empty string"]);
    }
    const source = await tenant.sources.get(sourceId);
    if (source === null || source.assistantId !== assistantId) {
      throw new NotFound();
    }
    if (options.requireKind !== undefined && source.kind !== options.requireKind) {
      throw new BadRequest([`sourceId: must be a ${options.requireKind} source`]);
    }
    return source;
  }

  return tenant.sources.getDefaultPush(assistantId);
}

async function resolveOrCreatePushSource(
  tenant: Tenant,
  assistantId: string,
  rawBody: Record<string, unknown>,
  options: SourceOptions,
): Promise<SourceRow> {
  const label = readSourceLabel(rawBody);
  if (label !== undefined) {
    return tenant.sources.getOrCreatePushByLabel({
      id: newId("src"),
      assistantId,
      label,
      createdAt: Date.now(),
    });
  }
  if (rawBody.sourceId !== undefined && rawBody.sourceId !== null) {
    const existing = await findExistingSource(tenant, assistantId, rawBody, options);
    if (existing !== null) return existing;
    throw new NotFound();
  }

  return tenant.sources.getOrCreateDefaultPush({
    id: newId("src"),
    assistantId,
    createdAt: Date.now(),
  });
}

function readStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new BadRequest([`${field}: must be an array of strings`]);
  }
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.trim() === "") {
      throw new BadRequest([`${field}: every item must be a non-empty string`]);
    }
    out.push(item.trim());
  }
  return out;
}

/**
 * Validates the whole batch, then writes the R2 object, upserts the D1 row,
 * and enqueues `{ orgId, documentId, contentHash }` for documents whose
 * content hash changed.
 */
export async function pushDocuments(
  deps: PushDeps,
  scope: IngestScope,
  rawBody: unknown,
  options: SourceOptions = {},
): Promise<IngestCounts> {
  if (!isPlainObject(rawBody)) {
    throw new BadRequest(["body: must be a JSON object"]);
  }
  if (!Array.isArray(rawBody.documents)) {
    throw new BadRequest(["documents: must be an array"]);
  }
  if (rawBody.documents.length > MAX_BATCH_DOCUMENTS) {
    throw new TooLarge(`batch exceeds ${MAX_BATCH_DOCUMENTS} documents`);
  }

  // Validate and size-check the whole batch before writing anything so an
  // invalid or oversized document never leaves partial state behind.
  const documents: DocumentInput[] = rawBody.documents.map((raw) => {
    if (
      isPlainObject(raw) &&
      typeof raw.markdown === "string" &&
      encoder.encode(raw.markdown).byteLength > MAX_DOCUMENT_MARKDOWN_BYTES
    ) {
      throw new TooLarge(`document exceeds ${MAX_DOCUMENT_MARKDOWN_BYTES} bytes`);
    }
    const parsed = parseDocumentInput(raw);
    if (!parsed.ok) {
      throw new BadRequest(parsed.errors);
    }
    // Refused here, while the caller can still act on it: the consumer cannot
    // commit more chunks than one D1 batch holds, and indexing only the first
    // part would mark the whole document as indexed.
    const parts = chunkMarkdown(parsed.value.markdown);
    if (exceedsChunkBudget(parts)) {
      throw new BadRequest([
        `markdown: "${parsed.value.externalId}" splits into ${parts.length} sections, more than the ${MAX_CHUNKS} one document can hold. Split it into smaller documents.`,
      ]);
    }
    return parsed.value;
  });

  const source = await resolveOrCreatePushSource(deps.tenant, scope.assistantId, rawBody, options);
  const existing = await deps.tenant.documents.existingFor(
    source.id,
    documents.map((doc) => doc.externalId),
  );

  let written = 0;
  let unchanged = 0;

  for (const document of documents) {
    const hash = await contentHash(document.title, document.markdown);
    const prev = existing.get(document.externalId);
    if (prev && prev.contentHash === hash) {
      let metadataUpdated = false;
      if (prev.url !== document.url) {
        const updated = await deps.tenant.documents.updateMetadata(
          prev.id,
          document.title,
          document.url,
          prev.contentHash,
          Date.now(),
        );
        if (updated) {
          metadataUpdated = true;
          existing.set(document.externalId, { ...prev, url: document.url });
        }
      }

      if (prev.url === document.url || metadataUpdated) {
        if (prev.indexedHash === hash) {
          // Indexed by an older ingest version: the text is unchanged, so it
          // still counts as unchanged, but it is queued once to be rebuilt.
          if ((prev.ingestVersion ?? INGEST_VERSION) < INGEST_VERSION && prev.bodyKey !== null) {
            await deps.queue.send({ orgId: scope.orgId, documentId: prev.id, contentHash: hash });
          }
          if (metadataUpdated) {
            written++;
          } else {
            unchanged++;
          }
          continue;
        }
        if (prev.bodyKey !== null) {
          await deps.queue.send({
            orgId: scope.orgId,
            documentId: prev.id,
            contentHash: hash,
          });
          written++;
          continue;
        }
      }
    }

    const candidateId = prev?.id ?? newId("doc");
    const objectKey = documentObjectKey(scope.orgId, candidateId);
    await deps.docs.put(objectKey, document.markdown);

    const input = {
      id: candidateId,
      sourceId: source.id,
      externalId: document.externalId,
      url: document.url,
      title: document.title,
      contentHash: hash,
      bodyKey: objectKey,
      updatedAt: Date.now(),
    };
    const saved =
      options.syncRun === undefined
        ? await deps.tenant.documents.upsert(input)
        : await deps.tenant.documents.upsertForSync(input, {
            runId: options.syncRun.runId,
            now: options.syncRun.now(),
          });
    if (saved === null) {
      await tryDeleteObject(deps.docs, objectKey, candidateId);
      throw new SyncRunEnded("sync run no longer holds the source");
    }

    await deps.queue.send({
      orgId: scope.orgId,
      documentId: saved.id,
      contentHash: hash,
    });

    if (prev?.bodyKey && prev.bodyKey !== saved.bodyKey) {
      await tryDeleteObject(deps.docs, prev.bodyKey, saved.id);
    }

    existing.set(document.externalId, {
      id: saved.id,
      url: saved.url,
      contentHash: hash,
      indexedHash: saved.indexedHash,
      bodyKey: saved.bodyKey,
    });
    written++;
  }

  return { written, unchanged, deleted: 0 };
}

/**
 * Deletes these documents of one source (cascading chunks) in one D1 batch,
 * then cleans up their vectors and R2 bodies on a best-effort basis. Returns
 * how many rows were actually removed.
 */
export async function removeSourceDocuments(
  deps: DeleteDeps,
  sourceId: string,
  toDelete: ReadonlyArray<{ id: string; bodyKey: string | null }>,
): Promise<number> {
  // One D1 batch for every row, then batched cleanup: a large source or
  // prune stays within the per-request query and subrequest limits instead
  // of costing several calls per document.
  // With repeated blocks to keep up, the batch that deletes the pages also
  // records that the source is owed a reconciliation, so no removal can
  // complete without it (see "Repeated blocks").
  const repeated = deps.repeated;
  const removed = await deps.tenant.documents.removeMany(
    toDelete.map((doc) => doc.id),
    { oweRepeated: repeated === undefined ? undefined : sourceId },
  );

  const vectorIds = [...removed.values()].flat();
  if (vectorIds.length > 0) {
    try {
      await deps.retriever.remove(vectorIds);
    } catch (err) {
      console.warn("ingest delete: best-effort vector cleanup failed", {
        sourceId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const bodyKeys = toDelete
    .filter((doc) => removed.has(doc.id) && doc.bodyKey !== null)
    .map((doc) => doc.bodyKey as string);
  for (let i = 0; i < bodyKeys.length; i += R2_DELETE_KEYS_LIMIT) {
    await tryDeleteObject(deps.docs, bodyKeys.slice(i, i + R2_DELETE_KEYS_LIMIT), sourceId);
  }
  // Fewer pages: a block may now be over the threshold, or under it. The
  // source is reconciled now, or a retried `repeated_source` message does
  // it; a removal with nothing to remove still runs one an earlier removal
  // owes. Throws only when neither could be arranged (the removal is done
  // and the owed reconciliation stays recorded; retrying it runs it).
  if (repeated !== undefined) {
    await reconcileAfterRemoval(
      deps.tenant,
      sourceId,
      repeated.queue,
      repeated.orgId,
      removed.size > 0,
    );
  }
  return removed.size;
}

/**
 * Deletes documents by `externalIds` or prunes everything not in `keep`,
 * always within one source: `sourceId`, the push source named by `source`, or
 * the default push source. Documents of other sources are never touched.
 * Deletes the D1 row first (cascading chunks), then performs best-effort
 * cleanup of vectors and R2 objects.
 */
export async function deleteDocuments(
  deps: DeleteDeps,
  scope: IngestScope,
  rawBody: unknown,
  options: SourceOptions = {},
): Promise<IngestCounts> {
  if (!isPlainObject(rawBody)) {
    throw new BadRequest(["body: must be a JSON object"]);
  }

  const isPrune = rawBody.prune === true;
  const hasExternalIds = rawBody.externalIds !== undefined;
  if (!isPrune && !hasExternalIds) {
    throw new BadRequest(["body: must provide externalIds or prune: true"]);
  }

  const keepSet = isPrune
    ? new Set(rawBody.keep === undefined ? [] : readStringArray(rawBody.keep, "keep"))
    : null;
  let externalIds: string[] = [];
  if (!isPrune) {
    const rawIds = readStringArray(rawBody.externalIds, "externalIds");
    if (rawIds.length > MAX_BATCH_DOCUMENTS) {
      throw new BadRequest([`externalIds: must contain at most ${MAX_BATCH_DOCUMENTS} items`]);
    }
    externalIds = [...new Set(rawIds)];
  }

  const source = await findExistingSource(deps.tenant, scope.assistantId, rawBody, options);
  if (source === null) {
    return { written: 0, unchanged: 0, deleted: 0 };
  }

  const toDelete: DocumentRow[] =
    keepSet !== null
      ? (await deps.tenant.documents.listBySource(source.id)).filter(
          (doc) => !keepSet.has(doc.externalId),
        )
      : await deps.tenant.documents.getByExternalIds(source.id, externalIds);

  const deleted = await removeSourceDocuments(deps, source.id, toDelete);

  return { written: 0, unchanged: 0, deleted };
}
