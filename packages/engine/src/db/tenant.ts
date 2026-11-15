import type { Principal } from "../seams/types.js";
import { assistantsFor } from "./assistants.js";
import { conversationsFor } from "./conversations.js";
import { documentsFor } from "./documents.js";
import { feedbackFor } from "./feedback.js";
import { mcpFor } from "./mcp.js";
import { messagesFor } from "./messages.js";
import { providerSettingsFor } from "./providerSettings.js";
import { reportsFor } from "./reports.js";
import { sourcesFor } from "./sources.js";
import { testsFor } from "./tests.js";
import { usageFor } from "./usage.js";
import { versionsFor } from "./versions.js";

export interface IngestScope {
  orgId: string;
  assistantId: string;
}

export interface PublicScope {
  orgId: string;
  assistantId: string;
}

export interface Tenant {
  readonly assistants: ReturnType<typeof assistantsFor>;
  readonly versions: ReturnType<typeof versionsFor>;
  readonly sources: ReturnType<typeof sourcesFor>;
  readonly documents: ReturnType<typeof documentsFor>;
  readonly conversations: ReturnType<typeof conversationsFor>;
  readonly messages: ReturnType<typeof messagesFor>;
  readonly feedback: ReturnType<typeof feedbackFor>;
  readonly mcp: ReturnType<typeof mcpFor>;
  readonly providerSettings: ReturnType<typeof providerSettingsFor>;
  readonly tests: ReturnType<typeof testsFor>;
  readonly usage: ReturnType<typeof usageFor>;
  readonly reports: ReturnType<typeof reportsFor>;
}

/**
 * A database handle bound to one org. Handlers get this instead of a
 * `D1Database`: the filter is captured when the handle is built, so forgetting
 * it is not an available mistake. Every constructor takes an org the auth
 * seam produced: a `Principal` (`authenticate`), or an `IngestScope`,
 * `PublicScope` or queued org (`resolveOrg`, then a credential matched inside
 * that org; see `public.ts`). None can come from a body or URL.
 */
export const forPrincipal = (db: D1Database, principal: Principal): Tenant =>
  build(db, principal.orgId);

/** Builds a `Tenant` from an ingest bearer key matched inside the seam's org. */
export const forIngestScope = (db: D1Database, scope: IngestScope): Tenant =>
  build(db, scope.orgId);

/** Builds a `Tenant` from a public key or message id matched inside the seam's org. */
export const forPublicScope = (db: D1Database, scope: PublicScope): Tenant =>
  build(db, scope.orgId);

/**
 * Builds a `Tenant` for one ingest Queue message, from the org the auth seam
 * returned for the message's claimed `orgId` (`resolveOrg`, `queued_ingest`).
 * Every read still goes through this tenant, so a message whose org does not
 * own the document finds nothing and is dropped.
 */
export const forQueuedIngest = (db: D1Database, resolvedOrgId: string): Tenant =>
  build(db, resolvedOrgId);

function build(db: D1Database, orgId: string): Tenant {
  // Handlers reach tables only through a `Tenant`, and the builders above take
  // an org from the auth seam (a principal, an ingest or public scope, or the
  // org `resolveOrg` returned), never from a request. This is a convention,
  // not a type guarantee: the per-table accessors (`versionsFor` and the
  // rest), `db/public.ts`, `usageFor` and `publishedCapMicros` are exported
  // and take an `orgId`, and `chat/route.ts` holds the raw `D1Database` for
  // `db/public.ts`. Callers of those must pass a seam-derived org.
  return {
    assistants: assistantsFor(db, orgId),
    versions: versionsFor(db, orgId),
    sources: sourcesFor(db, orgId),
    documents: documentsFor(db, orgId),
    conversations: conversationsFor(db, orgId),
    messages: messagesFor(db, orgId),
    feedback: feedbackFor(db, orgId),
    mcp: mcpFor(db, orgId),
    providerSettings: providerSettingsFor(db, orgId),
    tests: testsFor(db, orgId),
    usage: usageFor(db, orgId),
    reports: reportsFor(db, orgId),
  };
}
