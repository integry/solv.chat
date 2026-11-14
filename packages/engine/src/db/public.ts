/**
 * Scope resolution for the entry points that have no session.
 *
 * `docs/architecture.md` says route handlers receive `org_id` from the auth
 * seam. That holds for `/api/admin/*`, where `AuthProvider` resolves the
 * principal. Three public entry points cannot have a principal, so their org
 * is derived from a credential instead — never from a URL or body field:
 *
 * - `POST /v1/chat`, `GET /v1/assistants/:key`: the widget's public key.
 * - `POST /v1/feedback`: the message id the engine itself issued.
 * - `/v1/ingest/:assistantId/*`: the hashed bearer ingest key.
 * - `OPTIONS /v1/chat`, `OPTIONS /v1/feedback`: a browser preflight carries
 *   no body, so no key; it learns only whether its Origin is on some
 *   assistant's allow-list, and no row or org leaves the lookup.
 *
 * (The Queue consumer is the fourth: its message is written only by the
 * engine, from one of the scopes above, and is re-checked against D1 by
 * `org_id`; see `forQueuedIngest` in `tenant.ts`.)
 *
 * These are the only statements in the engine that run before `org_id` is
 * known. Each returns the matched row's `org_id`; callers immediately build a
 * `Tenant` from it, so every statement after the lookup is tenant-scoped.
 */
import { safeJsonArray } from "./sql.js";

export interface PublicAssistant {
  id: string;
  orgId: string;
  name: string;
  publicKey: string;
  allowedOrigins: string[];
}

interface AssistantLookupRow {
  id: string;
  org_id: string;
  name: string;
  public_key: string;
  allowed_origins: string;
}

const mapAssistant = (row: AssistantLookupRow): PublicAssistant => ({
  id: row.id,
  orgId: row.org_id,
  name: row.name,
  publicKey: row.public_key,
  allowedOrigins: safeJsonArray<string>(row.allowed_origins),
});

/**
 * Resolves an assistant by its public key before `org_id` is known.
 *
 * This is a public-entry lookup (the widget sends `pk_...` in the clear,
 * never `org_id`). Callers must immediately build a `Tenant` from the returned
 * `orgId` via `forPublicScope` so every subsequent query is tenant-scoped.
 */
export async function assistantByPublicKey(
  db: D1Database,
  publicKey: string,
): Promise<PublicAssistant | null> {
  const row = await db
    .prepare(
      "SELECT id, org_id, name, public_key, allowed_origins FROM assistants WHERE public_key = ?1",
    )
    .bind(publicKey)
    .first<AssistantLookupRow>();
  return row ? mapAssistant(row) : null;
}

/**
 * Resolves the owning assistant for a message id before `org_id` is known.
 *
 * Used by `POST /v1/feedback` so origin checks, rate limits, and feedback
 * writes all bind to the message's actual assistant and org rather than
 * trusting caller-supplied tenant identifiers.
 */
export async function assistantForMessage(
  db: D1Database,
  messageId: string,
): Promise<PublicAssistant | null> {
  const row = await db
    .prepare(
      `SELECT a.id, a.org_id, a.name, a.public_key, a.allowed_origins
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id AND c.org_id = m.org_id
       JOIN assistants a ON a.id = c.assistant_id AND a.org_id = c.org_id
       WHERE m.id = ?1`,
    )
    .bind(messageId)
    .first<AssistantLookupRow>();
  return row ? mapAssistant(row) : null;
}

export interface IngestKeyRow {
  id: string;
  orgId: string;
  ingestKeyHash: string;
}

/**
 * Reads the stored ingest-key hash for an assistant before `org_id` is known.
 *
 * The bearer key *is* the authentication: the caller compares hashes in
 * constant time and only then builds a `Tenant` from the returned `orgId`
 * via `forIngestScope`.
 */
export async function assistantIngestKeyHash(
  db: D1Database,
  assistantId: string,
): Promise<IngestKeyRow | null> {
  const row = await db
    .prepare(
      "SELECT id, org_id, ingest_key_hash FROM assistants WHERE id = ?1 AND ingest_key_hash IS NOT NULL",
    )
    .bind(assistantId)
    .first<{ id: string; org_id: string; ingest_key_hash: string }>();
  return row ? { id: row.id, orgId: row.org_id, ingestKeyHash: row.ingest_key_hash } : null;
}

/**
 * Whether any assistant lists `origin` in its allowed origins.
 *
 * Used only to answer a CORS preflight, which carries no assistant key. The
 * answer is a yes/no about the caller's own Origin; the real request is still
 * checked against its own assistant's list.
 */
export async function originAllowedByAnyAssistant(
  db: D1Database,
  origin: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS hit FROM assistants, json_each(assistants.allowed_origins) AS allowed
       WHERE json_valid(assistants.allowed_origins) AND allowed.value = ?1 LIMIT 1`,
    )
    .bind(origin)
    .first<{ hit: number }>();
  return row !== null;
}
