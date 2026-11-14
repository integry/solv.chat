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

/** Returns a fresh, never-reused R2 object key for a document's Markdown body. */
export function documentObjectKey(
  orgId: string,
  documentId: string,
  bodyId = crypto.randomUUID(),
): string {
  return `org/${orgId}/doc/${documentId}/${bodyId}.md`;
}

async function tryDeleteObject(
  docs: { delete(key: string): Promise<unknown> },
  key: string,
  documentId: string,
): Promise<void> {
  try {
    await docs.delete(key);
  } catch (err) {
    console.warn("ingest: best-effort R2 delete failed", {
      documentId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
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
 * Validates the whole batch, then writes the R2 object, upserts the D1 row,
 * and enqueues `{ orgId, documentId, contentHash }` for documents whose
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
      if (prev.url === document.url) {
        unchanged++;
        continue;
      }
      const updated = await deps.tenant.documents.updateMetadata(
        prev.id,
        document.title,
        document.url,
        Date.now(),
      );
      if (updated) {
        existing.set(document.externalId, { ...prev, url: document.url });
        written++;
        continue;
      }
    }

    const candidateId = prev?.id ?? newId("doc");
    const objectKey = documentObjectKey(scope.orgId, candidateId);
    await deps.docs.put(objectKey, document.markdown);

    const saved = await deps.tenant.documents.upsert({
      id: candidateId,
      sourceId: source.id,
      externalId: document.externalId,
      url: document.url,
      title: document.title,
      contentHash: hash,
      bodyKey: objectKey,
      updatedAt: Date.now(),
    });

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
      bodyKey: saved.bodyKey,
    });
    written++;
  }

  return { written, unchanged, deleted: 0 };
}

/**
 * Deletes documents by `externalIds` or prunes everything not in `keep`.
 * Deletes the D1 row first (cascading chunks), then performs best-effort
 * cleanup of vectors and R2 objects.
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
    const chunks = await deps.tenant.documents.listChunks(doc.id);
    const removed = await deps.tenant.documents.remove(doc.id);
    if (!removed) {
      continue;
    }
    deleted++;

    const vectorIds = chunks.map((chunk) => chunk.id);
    if (vectorIds.length > 0) {
      try {
        await deps.retriever.remove(vectorIds);
      } catch (err) {
        console.warn("ingest delete: best-effort vector cleanup failed", {
          documentId: doc.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (doc.bodyKey !== null) {
      await tryDeleteObject(deps.docs, doc.bodyKey, doc.id);
    }
  }

  return { written: 0, unchanged: 0, deleted };
}
