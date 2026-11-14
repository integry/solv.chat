import { sha256Hex } from "../admin/ingestKeys.js";
import type { IngestScope } from "../db/tenant.js";

const encoder = new TextEncoder();

function constantTimeEqual(a: string, b: string): boolean {
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  let diff = left.length ^ right.length;
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}

function extractBearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (header === null) return null;
  const match = /^Bearer\s+(\S+)$/.exec(header.trim());
  return match?.[1] ?? null;
}

/**
 * Resolves a bearer ingest key to an `IngestScope`.
 *
 * The URL's `:assistantId` is used only inside the lookup, and `orgId` comes
 * from the row that matched — never from the URL or body. A key for another
 * assistant matches no row and gets the same 401 as a wrong key.
 */
export async function ingestScopeFor(
  db: D1Database,
  request: Request,
  assistantIdFromUrl: string,
): Promise<IngestScope | null> {
  const presented = extractBearerToken(request);
  if (presented === null || assistantIdFromUrl === "") return null;

  const presentedHash = await sha256Hex(presented);
  // This is the one statement in the engine that filters on `id` before it
  // knows `org_id`, because the bearer key *is* the authentication; callers
  // build a `Tenant` from its result via `forIngestScope`.
  const row = await db
    .prepare(
      "SELECT id, org_id, ingest_key_hash FROM assistants WHERE id = ?1 AND ingest_key_hash IS NOT NULL",
    )
    .bind(assistantIdFromUrl)
    .first<{ id: string; org_id: string; ingest_key_hash: string }>();

  if (row === null || !constantTimeEqual(presentedHash, row.ingest_key_hash)) {
    return null;
  }

  return { orgId: row.org_id, assistantId: row.id };
}
