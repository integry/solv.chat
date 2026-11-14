import { newId, parseVersionConfig } from "@solvchat/core";
import type { Tenant } from "../db/tenant.js";
import type { VersionRow } from "../db/versions.js";
import { BadRequest, NotFound } from "./errors.js";

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

/** Validates and replaces the assistant's draft configuration. */
export async function updateDraft(
  tenant: Tenant,
  assistantId: string,
  body: unknown,
): Promise<VersionRow> {
  const parsed = parseVersionConfig(body);
  if (!parsed.ok) throw new BadRequest(parsed.errors);

  const updated = await tenant.versions.updateDraft(assistantId, parsed.value);
  if (!updated) throw new NotFound("assistant");

  const draft = await tenant.versions.draft(assistantId);
  if (draft === null) throw new NotFound("assistant");
  return draft;
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
  await tenant.versions.batch([
    // Archive first: the partial unique index allows one published row, so
    // promoting the draft would fail with the old one still published.
    tenant.versions.statements.archivePublished(assistantId),
    // The draft becomes the published version and keeps its id, so a "Try it"
    // conversation started against the draft still resolves afterwards.
    tenant.versions.statements.markPublished(draft.id, now),
    // A fresh draft with the same words: the owner keeps editing at once and
    // the "exactly one draft" invariant holds.
    tenant.versions.statements.insertDraft({
      id: newId("ver"),
      assistantId,
      config: draft.config,
      createdAt: now,
    }),
  ]);
  return { ...draft, state: "published", publishedAt: now };
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
