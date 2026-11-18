/**
 * Credential lookups for the entry points that have no session.
 *
 * `docs/architecture.md` says route handlers receive `org_id` from the auth
 * seam. On `/api/admin/*` that is `AuthProvider.authenticate`. The public,
 * ingest and queue entry points have no principal, so they ask
 * `AuthProvider.resolveOrg` which org the request belongs to (see
 * `ScopeClaim` in `seams/types.ts`), and only then look their credential up
 * here — inside that org, like every other statement:
 *
 * - `POST /v1/chat`, `GET /v1/assistants/:key`: the widget's public key.
 * - `POST /v1/feedback`: the message id the engine itself issued.
 * - `/v1/ingest/:assistantId/*`: the hashed bearer ingest key.
 * - `OPTIONS /v1/chat`, `OPTIONS /v1/feedback`: a browser preflight carries
 *   no body, so no key; it learns only whether its Origin is on one of the
 *   org's allow-lists, and no row leaves the lookup.
 *
 * A credential that belongs to another org matches no row, exactly as an
 * unknown one does.
 */
import { prepare, safeJsonArray } from "./sql.js";

export interface PublicAssistant {
  id: string;
  orgId: string;
  name: string;
  publicKey: string;
  allowedOrigins: string[];
  /** When the owner first asked a "Try it" question; null until then. */
  triedAt?: number | null;
  /** When the widget first loaded on an allowed origin; null until then. */
  widgetSeenAt?: number | null;
}

interface AssistantLookupRow {
  id: string;
  org_id: string;
  name: string;
  public_key: string;
  allowed_origins: string;
  tried_at?: number | null;
  widget_seen_at?: number | null;
}

const mapAssistant = (row: AssistantLookupRow): PublicAssistant => ({
  id: row.id,
  orgId: row.org_id,
  name: row.name,
  publicKey: row.public_key,
  allowedOrigins: safeJsonArray<string>(row.allowed_origins),
  ...(row.tried_at !== undefined ? { triedAt: row.tried_at } : {}),
  ...(row.widget_seen_at !== undefined ? { widgetSeenAt: row.widget_seen_at } : {}),
});

/** The org's assistant with this public key, or null. */
export async function assistantByPublicKey(
  db: D1Database,
  orgId: string,
  publicKey: string,
): Promise<PublicAssistant | null> {
  const row = await prepare(
    db,
    "SELECT id, org_id, name, public_key, allowed_origins, tried_at, widget_seen_at FROM assistants WHERE org_id = ?1 AND public_key = ?2",
  )
    .bind(orgId, publicKey)
    .first<AssistantLookupRow>();
  return row ? mapAssistant(row) : null;
}

/**
 * The org's assistant that owns this message, or null.
 *
 * Used by `POST /v1/feedback` so origin checks, rate limits, and feedback
 * writes all bind to the message's actual assistant rather than trusting
 * caller-supplied identifiers.
 */
export async function assistantForMessage(
  db: D1Database,
  orgId: string,
  messageId: string,
): Promise<PublicAssistant | null> {
  const row = await prepare(
    db,
    `SELECT a.id, a.org_id, a.name, a.public_key, a.allowed_origins
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id AND c.org_id = m.org_id
       JOIN assistants a ON a.id = c.assistant_id AND a.org_id = c.org_id
      WHERE m.org_id = ?1 AND m.id = ?2`,
  )
    .bind(orgId, messageId)
    .first<AssistantLookupRow>();
  return row ? mapAssistant(row) : null;
}

export interface IngestKeyRow {
  id: string;
  orgId: string;
  ingestKeyHash: string;
}

/**
 * The stored ingest-key hash for one of the org's assistants. The caller
 * compares hashes in constant time before building a `Tenant`.
 */
export async function assistantIngestKeyHash(
  db: D1Database,
  orgId: string,
  assistantId: string,
): Promise<IngestKeyRow | null> {
  const row = await prepare(
    db,
    "SELECT id, org_id, ingest_key_hash FROM assistants WHERE org_id = ?1 AND id = ?2 AND ingest_key_hash IS NOT NULL",
  )
    .bind(orgId, assistantId)
    .first<{ id: string; org_id: string; ingest_key_hash: string }>();
  return row ? { id: row.id, orgId: row.org_id, ingestKeyHash: row.ingest_key_hash } : null;
}

/**
 * Whether any of the org's assistants lists `origin` as allowed.
 *
 * Used only to answer a CORS preflight, which carries no assistant key. The
 * answer is a yes/no about the caller's own Origin, read from the
 * `assistant_origins` index; the real request is still checked against its
 * own assistant's list.
 */
export async function originAllowedInOrg(
  db: D1Database,
  orgId: string,
  origin: string,
): Promise<boolean> {
  const row = await prepare(
    db,
    "SELECT 1 AS hit FROM assistant_origins WHERE org_id = ?1 AND origin = ?2 LIMIT 1",
  )
    .bind(orgId, origin)
    .first<{ hit: number }>();
  return row !== null;
}
