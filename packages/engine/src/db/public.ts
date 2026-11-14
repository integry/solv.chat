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
