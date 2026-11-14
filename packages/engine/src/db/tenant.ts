import type { Principal } from "../seams/types.js";
import { assistantsFor } from "./assistants.js";
import { conversationsFor } from "./conversations.js";
import { documentsFor } from "./documents.js";
import { feedbackFor } from "./feedback.js";
import { mcpFor } from "./mcp.js";
import { messagesFor } from "./messages.js";
import { sourcesFor } from "./sources.js";
import { testsFor } from "./tests.js";
import { versionsFor } from "./versions.js";

export interface IngestScope {
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
  readonly tests: ReturnType<typeof testsFor>;
}

/**
 * A database handle bound to one org. Handlers get this instead of a
 * `D1Database`: the filter is captured when the handle is built, so forgetting
 * it is not an available mistake. Constructible only from a `Principal` (auth
 * seam) or an `IngestScope` (a row matched by a hashed bearer key) — neither can
 * come from a body or URL.
 */
export const forPrincipal = (db: D1Database, principal: Principal): Tenant =>
  build(db, principal.orgId);

/** Builds a `Tenant` from an authenticated ingest bearer-key scope. */
export const forIngestScope = (db: D1Database, scope: IngestScope): Tenant =>
  build(db, scope.orgId);

function build(db: D1Database, orgId: string): Tenant {
  // Nothing exported takes an orgId argument, which could be the wrong one.
  return {
    assistants: assistantsFor(db, orgId),
    versions: versionsFor(db, orgId),
    sources: sourcesFor(db, orgId),
    documents: documentsFor(db, orgId),
    conversations: conversationsFor(db, orgId),
    messages: messagesFor(db, orgId),
    feedback: feedbackFor(db, orgId),
    mcp: mcpFor(db, orgId),
    tests: testsFor(db, orgId),
  };
}
