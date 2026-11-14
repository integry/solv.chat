import { assistantIngestKeyHash } from "../db/public.js";
import type { IngestScope } from "../db/tenant.js";
import { constantTimeEqual, sha256Hex } from "../util/crypto.js";

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
  const row = await assistantIngestKeyHash(db, assistantIdFromUrl);
  if (row === null || !constantTimeEqual(presentedHash, row.ingestKeyHash)) {
    return null;
  }

  return { orgId: row.orgId, assistantId: row.id };
}
