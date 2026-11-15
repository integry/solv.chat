import { newId, parseVersionConfig } from "@solvchat/core";
import type { Tenant } from "../db/tenant.js";
import { expectedVersionConfig, type VersionRow } from "../db/versions.js";
import { BadRequest, Conflict, NotFound } from "./errors.js";

/** Lists version history for an assistant, newest first. */
export async function listVersions(tenant: Tenant, assistantId: string): Promise<VersionRow[]> {
  const assistant = await tenant.assistants.get(assistantId);
  if (assistant === null) throw new NotFound("assistant");
  return tenant.versions.history(assistantId);
}

/** Reads the assistant's current draft version. */
export async function getDraft(tenant: Tenant, assistantId: string): Promise<VersionRow> {
  const draft = await tenant.versions.draft(assistantId);
  if (draft === null) throw new NotFound("assistant");
  return draft;
}

const MAX_DRAFT_UPDATE_ATTEMPTS = 5;

/** Validates and updates the assistant's draft configuration, preserving omitted sections. */
export async function updateDraft(
  tenant: Tenant,
  assistantId: string,
  body: unknown,
): Promise<VersionRow> {
  let expectedId: string | null = null;

  for (let attempt = 0; attempt < MAX_DRAFT_UPDATE_ATTEMPTS; attempt++) {
    const existing = await tenant.versions.draft(assistantId);
    if (existing === null) throw new NotFound("assistant");

    if (expectedId !== null && existing.id !== expectedId) {
      // Fence against the original draft being promoted between read and write.
      throw new Conflict("The draft changed because it was published. Please try again.");
    }
    expectedId = existing.id;

    const parsed = parseVersionConfig(body, existing.config);
    if (!parsed.ok) throw new BadRequest(parsed.errors);

    const updated = await tenant.versions.updateDraft(assistantId, parsed.value, existing);
    if (updated) {
      return { ...existing, config: parsed.value };
    }
  }

  throw new Conflict("The draft changed while you were saving. Please try again.");
}

/** Returns a stable SHA-256 hex digest of a draft's exact stored config bytes. */
export async function configRevision(draft: VersionRow): Promise<string> {
  const bytes = new TextEncoder().encode(expectedVersionConfig(draft));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Publishing promotes the current draft row to `published` (it keeps its id,
 * so a "Try it" conversation started against the draft still resolves) and
 * inserts a fresh draft with the same config under a new id. The promoted row
 * is never edited again, so it stays the snapshot visitors saw: History stays
 * truthful and rollback has something to go back to. Archive, promote and the
 * new draft run in one db.batch, so a crash part-way cannot leave the
 * assistant with no published version or no draft. See
 * `versionsFor().publishDraft` for the guards.
 *
 * When `expectedDraft` is supplied (from the publish test gate), promotion is
 * atomically bound to that exact draft row and configuration revision.
 * When `overrideRunId` is supplied, the failing test run's `published_anyway`
 * flag is recorded in the same batch, conditioned on promotion succeeding.
 */
export async function publishDraft(
  tenant: Tenant,
  assistantId: string,
  expectedDraft?: VersionRow,
  overrideRunId?: string,
): Promise<VersionRow> {
  const draft = expectedDraft ?? (await tenant.versions.draft(assistantId));
  if (draft === null) throw new NotFound("assistant");

  const now = Date.now();
  const nextDraftId = newId("ver");
  const extraStatements = overrideRunId
    ? [
        tenant.tests.statements.markPublishedAnyway({
          runId: overrideRunId,
          assistantId,
          promotedVersionId: draft.id,
          nextDraftId,
          publishedAt: now,
        }),
      ]
    : undefined;
  const published = await tenant.versions.publishDraft(
    assistantId,
    draft.id,
    nextDraftId,
    now,
    expectedDraft ? expectedVersionConfig(expectedDraft) : undefined,
    extraStatements,
  );
  if (published === null) {
    const assistant = await tenant.assistants.get(assistantId);
    if (assistant === null) throw new NotFound("assistant");
    throw new Conflict(
      expectedDraft
        ? "The draft changed while tests were running. Please try again."
        : "This draft was already published. Please try again.",
    );
  }
  return published;
}

/**
 * Rollback republishes an archived version's config as a new published row.
 * It never resurrects the old row: that row's created_at is a fact about when
 * those words were first written, and History shows both events.
 */
export async function rollbackTo(
  tenant: Tenant,
  assistantId: string,
  versionId: string,
): Promise<VersionRow> {
  const target = await tenant.versions.byId(assistantId, versionId);
  if (target === null) throw new NotFound("version");
  if (target.state !== "archived") {
    // Plain words, because this reaches the admin UI: rolling back to the live
    // version or the draft is a no-op the owner should not think happened.
    throw new BadRequest(["versionId: only an older version can be restored"]);
  }

  const now = Date.now();
  const id = newId("ver");
  await tenant.versions.batch([
    tenant.versions.statements.archivePublished(assistantId),
    tenant.versions.statements.insertPublished({
      id,
      assistantId,
      config: target.config,
      createdAt: now,
      publishedAt: now,
    }),
  ]);
  return {
    id,
    orgId: target.orgId,
    assistantId,
    state: "published",
    config: target.config,
    createdAt: now,
    publishedAt: now,
  };
}
