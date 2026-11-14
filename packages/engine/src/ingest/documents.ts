import {
  type DocumentInput,
  MAX_DOCUMENT_MARKDOWN_BYTES,
  newId,
  parseDocumentInput,
} from "@solvchat/core";
import { BadRequest, NotFound } from "../admin/errors.js";
import type { DocumentRow } from "../db/documents.js";
import type { SourceRow } from "../db/sources.js";
import type { IngestScope, Tenant } from "../db/tenant.js";
import type { Retriever } from "../providers/retrieval.js";

export const MAX_BATCH_DOCUMENTS = 100;

export class TooLarge extends Error {}

export interface IngestCounts {
  written: number;
  unchanged: number;
  deleted: number;
}

export interface IngestQueueMessage {
  documentId: string;
  orgId: string;
  revision?: number;
}

export interface PushDeps {
  tenant: Tenant;
  docs: { put(key: string, value: string): Promise<unknown> };
  queue: { send(message: IngestQueueMessage): Promise<unknown> };
}

export interface DeleteDeps {
  tenant: Tenant;
  docs: { delete(key: string): Promise<unknown> };
  retriever: Pick<Retriever, "remove">;
}

const encoder = new TextEncoder();

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * SHA-256 of title and body. The title is included because retitling a page
 * is a real change the retriever should see; hashing the body alone would make
 * it a no-op.
 */
export async function contentHash(title: string, markdown: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(`${title}\n${markdown}`));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Returns the R2 object key for a specific revision of a document's Markdown body. */
export function documentObjectKey(orgId: string, documentId: string, revision = 1): string {
  return `org/${orgId}/doc/${documentId}/v${revision}.md`;
}

async function findExistingSource(
  tenant: Tenant,
  assistantId: string,
  sourceId: unknown,
): Promise<SourceRow | null> {
  if (sourceId !== undefined && sourceId !== null) {
    if (typeof sourceId !== "string" || sourceId.trim() === "") {
      throw new BadRequest(["sourceId: must be a non-empty string"]);
    }
    const source = await tenant.sources.get(sourceId);
    if (source === null || source.assistantId !== assistantId) {
      throw new NotFound();
    }
    return source;
  }

  return tenant.sources.getDefaultPush(assistantId);
}

async function resolveOrCreatePushSource(
  tenant: Tenant,
  assistantId: string,
  sourceId: unknown,
): Promise<SourceRow> {
  if (sourceId !== undefined && sourceId !== null) {
    const existing = await findExistingSource(tenant, assistantId, sourceId);
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
 * Validates the whole batch, then writes and enqueues only documents whose
 * content hash changed.
 */
export async function pushDocuments(
  deps: PushDeps,
  scope: IngestScope,
  rawBody: unknown,
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
    return parsed.value;
  });

  const source = await resolveOrCreatePushSource(deps.tenant, scope.assistantId, rawBody.sourceId);
  const existing = await deps.tenant.documents.pushStatesFor(
    source.id,
    documents.map((doc) => doc.externalId),
  );

  let written = 0;
  let unchanged = 0;

  for (const document of documents) {
    const hash = await contentHash(document.title, document.markdown);
    const prev = existing.get(document.externalId);
    if (prev && prev.contentHash === hash && prev.complete) {
      unchanged++;
      continue;
    }

    const saved = await deps.tenant.documents.upsert({
      id: newId("doc"),
      sourceId: source.id,
      externalId: document.externalId,
      url: document.url,
      title: document.title,
      contentHash: hash,
      updatedAt: Date.now(),
    });
    // Store the body before enqueuing so an immediate consumer never misses it,
    // and only mark each obligation complete after it succeeds so retries resume.
    let current = saved.storedRevision >= saved.revision;
    if (!current) {
      await deps.docs.put(
        documentObjectKey(scope.orgId, saved.id, saved.revision),
        document.markdown,
      );
      current = await deps.tenant.documents.markBodyStored(saved.id, saved.revision);
    }
    if (current && saved.enqueuedRevision < saved.revision) {
      await deps.queue.send({
        documentId: saved.id,
        orgId: scope.orgId,
        revision: saved.revision,
      });
      current = await deps.tenant.documents.markEnqueued(saved.id, saved.revision);
    }
    if (current) {
      existing.set(document.externalId, { contentHash: hash, complete: true });
    }
    written++;
  }

  return { written, unchanged, deleted: 0 };
}

/**
 * Deletes documents (and their chunks, R2 bodies, and vectors) by
 * `externalIds`, or prunes everything not in `keep`.
 */
export async function deleteDocuments(
  deps: DeleteDeps,
  scope: IngestScope,
  rawBody: unknown,
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
  const externalIds = !isPrune
    ? [...new Set(readStringArray(rawBody.externalIds, "externalIds"))]
    : [];

  const source = await findExistingSource(deps.tenant, scope.assistantId, rawBody.sourceId);
  if (source === null) {
    return { written: 0, unchanged: 0, deleted: 0 };
  }

  const toDelete: DocumentRow[] = [];
  if (keepSet !== null) {
    const allDocs = await deps.tenant.documents.listBySource(source.id);
    for (const doc of allDocs) {
      if (!keepSet.has(doc.externalId)) {
        toDelete.push(doc);
      }
    }
  } else {
    for (const externalId of externalIds) {
      const doc = await deps.tenant.documents.getByExternalId(source.id, externalId);
      if (doc !== null) {
        toDelete.push(doc);
      }
    }
  }

  let deleted = 0;
  for (const doc of toDelete) {
    // Atomically mark deleting before snapshotting cleanup IDs so no new
    // pending saves or chunk commits can be admitted for this document.
    const marked = await deps.tenant.documents.markDeleting(doc.id);
    if (marked === null) {
      continue;
    }

    const [chunks, staleIds, pendingIds] = await Promise.all([
      deps.tenant.documents.listChunks(marked.id),
      deps.tenant.documents.listStaleVectors(marked.id),
      deps.tenant.documents.listAllPendingVectors(marked.id),
    ]);
    const vectorIds = [...new Set([...chunks.map((c) => c.id), ...staleIds, ...pendingIds])];
    if (vectorIds.length > 0) {
      await deps.retriever.remove(vectorIds);
    }
    await Promise.all([
      deps.tenant.documents.clearStaleVectors(marked.id, staleIds),
      deps.tenant.documents.clearAllPendingVectors(marked.id),
    ]);
    for (let rev = 1; rev <= marked.revision; rev++) {
      await deps.docs.delete(documentObjectKey(scope.orgId, marked.id, rev));
    }
    if (await deps.tenant.documents.remove(marked.id)) {
      deleted++;
    }
  }

  return { written: 0, unchanged: 0, deleted };
}
