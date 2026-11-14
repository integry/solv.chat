import { newId, parseVersionConfig } from "@solvchat/core";
import type { Tenant } from "../db/tenant.js";
import type { VersionRow } from "../db/versions.js";
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

    const updated = await tenant.versions.updateDraft(assistantId, parsed.value, {
      id: existing.id,
      config: existing.config,
    });
    if (updated) {
      return { ...existing, config: parsed.value };
    }
  }

  throw new Conflict("The draft changed while you were saving. Please try again.");
}

/**
 * Publishing copies rather than relabels: the published row is the snapshot a
 * visitor saw, so History stays truthful and rollback has something to go back
 * to. One db.batch, so a crash between the archive and the insert cannot leave
 * the assistant with no published version.
 *
 * The spec says Publish runs the tests. Answer tests are phase 2; that step
 * slots in at the top of this function.
 */
export async function publishDraft(tenant: Tenant, assistantId: string): Promise<VersionRow> {
  const draft = await tenant.versions.draft(assistantId);
  if (draft === null) throw new NotFound("assistant");

  const now = Date.now();
  const published = await tenant.versions.publishDraft(assistantId, draft.id, newId("ver"), now);
  if (published === null) {
    const assistant = await tenant.assistants.get(assistantId);
    if (assistant === null) throw new NotFound("assistant");
    throw new Conflict("This draft was already published. Please try again.");
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
