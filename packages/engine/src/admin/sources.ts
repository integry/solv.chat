import { isPlainObject, newId, parseSourceInput } from "@solvchat/core";
import type { DocumentSummaryRow } from "../db/documents.js";
import type { SourceRow, SourceWithStatsRow } from "../db/sources.js";
import type { Tenant } from "../db/tenant.js";
import { type DeleteDeps, deleteDocuments } from "../ingest/documents.js";
import { BadRequest, NotFound } from "./errors.js";

/** Lists all sources for an assistant with document counts and newest `updated_at`. */
export async function listSources(
  tenant: Tenant,
  assistantId: string,
): Promise<SourceWithStatsRow[]> {
  const assistant = await tenant.assistants.get(assistantId);
  if (assistant === null) throw new NotFound("assistant");
  return tenant.sources.listWithStats(assistantId);
}

/** Creates an `entry` or `sitemap` source for an assistant. `push` sources are created by ingest only. */
export async function createSource(
  tenant: Tenant,
  assistantId: string,
  body: unknown,
): Promise<SourceRow> {
  const assistant = await tenant.assistants.get(assistantId);
  if (assistant === null) throw new NotFound("assistant");

  const parsed = parseSourceInput(body);
  if (!parsed.ok) throw new BadRequest(parsed.errors);
  if (parsed.value.kind === "push") {
    throw new BadRequest(["kind: push sources are created by ingest"]);
  }

  return tenant.sources.create({
    id: newId("src"),
    assistantId,
    kind: parsed.value.kind,
    label: parsed.value.label,
    settings: parsed.value.settings,
    createdAt: Date.now(),
  });
}

/** Updates an `entry` or `sitemap` source's label or settings. `push` sources are read-only. */
export async function updateSource(
  tenant: Tenant,
  sourceId: string,
  body: unknown,
): Promise<SourceRow> {
  const existing = await tenant.sources.get(sourceId);
  if (existing === null) throw new NotFound("source");
  if (existing.kind === "push") {
    throw new BadRequest(["source: push sources cannot be edited"]);
  }
  if (!isPlainObject(body)) {
    throw new BadRequest(["body: must be a JSON object"]);
  }

  const parsed = parseSourceInput({
    kind: existing.kind,
    label: body.label ?? existing.label,
    settings: body.settings ?? existing.settings,
  });
  if (!parsed.ok) throw new BadRequest(parsed.errors);

  await tenant.sources.update(sourceId, {
    label: parsed.value.label,
    settings: parsed.value.settings,
  });

  return {
    ...existing,
    label: parsed.value.label,
    settings: parsed.value.settings,
  };
}

/**
 * Deletes an `entry` or `sitemap` source and cleans up its documents, R2
 * bodies, and retriever vectors. `push` sources cannot be deleted by hand.
 */
export async function deleteSource(deps: DeleteDeps, sourceId: string): Promise<{ deleted: true }> {
  const existing = await deps.tenant.sources.get(sourceId);
  if (existing === null) throw new NotFound("source");
  if (existing.kind === "push") {
    throw new BadRequest(["source: push sources cannot be deleted"]);
  }

  await deleteDocuments(
    deps,
    { orgId: existing.orgId, assistantId: existing.assistantId },
    { sourceId, prune: true, keep: [] },
  );
  await deps.tenant.sources.remove(sourceId);
  return { deleted: true };
}

/** Lists a page of documents belonging to a source (metadata only, no bodies). */
export async function listSourceDocuments(
  tenant: Tenant,
  sourceId: string,
  options: { limit?: number; offset?: number } = {},
): Promise<{ documents: DocumentSummaryRow[]; total: number; limit: number; offset: number }> {
  const source = await tenant.sources.get(sourceId);
  if (source === null) throw new NotFound("source");

  const limit = Math.min(Math.max(1, Math.trunc(options.limit ?? 50)), 100);
  const offset = Math.max(0, Math.trunc(options.offset ?? 0));
  const { documents, total } = await tenant.documents.listBySourcePaged(sourceId, {
    limit,
    offset,
  });
  return { documents, total, limit, offset };
}

/** Fetches one document's metadata and Markdown body from R2. */
export async function getSourceDocument(
  tenant: Tenant,
  docs: Pick<R2Bucket, "get">,
  sourceId: string,
  documentId: string,
): Promise<{ document: DocumentSummaryRow; markdown: string }> {
  const source = await tenant.sources.get(sourceId);
  if (source === null) throw new NotFound("source");

  const doc = await tenant.documents.get(documentId);
  if (doc === null || doc.sourceId !== sourceId) throw new NotFound("document");

  const object = doc.bodyKey !== null ? await docs.get(doc.bodyKey) : null;
  const markdown = object !== null ? await object.text() : "";

  return {
    document: {
      id: doc.id,
      sourceId: doc.sourceId,
      externalId: doc.externalId,
      url: doc.url,
      title: doc.title,
      updatedAt: doc.updatedAt,
    },
    markdown,
  };
}
