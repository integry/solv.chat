import { assistantIngestKeyHash } from "../db/public.js";
import type { IngestScope } from "../db/tenant.js";
import type { AuthProvider } from "../seams/types.js";
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
 * `orgId` comes from the auth seam, never from the URL or body; the URL's
 * `:assistantId` is looked up only inside that org. A key for another
 * assistant, or an assistant in another org, matches no row and gets the
 * same 401 as a wrong key.
 */
export async function ingestScopeFor(
  db: D1Database,
  auth: Pick<AuthProvider, "resolveOrg">,
  request: Request,
  assistantIdFromUrl: string,
): Promise<IngestScope | null> {
  const presented = extractBearerToken(request);
  if (presented === null || assistantIdFromUrl === "") return null;

  const orgId = await auth.resolveOrg({ kind: "ingest_key", assistantId: assistantIdFromUrl });
  if (orgId === null) return null;

  const presentedHash = await sha256Hex(presented);
  const row = await assistantIngestKeyHash(db, orgId, assistantIdFromUrl);
  if (row === null || !constantTimeEqual(presentedHash, row.ingestKeyHash)) {
    return null;
  }

  return { orgId, assistantId: row.id };
}
