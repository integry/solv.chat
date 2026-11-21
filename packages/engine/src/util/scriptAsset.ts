import { sha256Hex } from "./crypto.js";

const CACHE_CONTROL = "public, max-age=300, must-revalidate, no-transform";

function matchesETag(ifNoneMatch: string | null, etag: string): boolean {
  if (ifNoneMatch === null) return false;
  if (ifNoneMatch.trim() === "*") return true;

  // If-None-Match uses weak comparison. Commas can occur inside quoted tags.
  // https://www.rfc-editor.org/rfc/rfc9110.html#section-13.1.2
  for (const [, tag] of ifNoneMatch.matchAll(/(?:^|,)\s*(?:W\/)?("[^"]*")\s*(?=,|$)/g)) {
    if (tag === etag) return true;
  }
  return false;
}

/** Builds a GET handler for one immutable script bundled with the Worker. */
export function scriptAsset(body: string, extraHeaders?: Record<string, string>) {
  let etag: string | undefined;
  return async (request: Request): Promise<Response> => {
    etag ??= `"${await sha256Hex(body)}"`;
    const headers = {
      ...extraHeaders,
      "cache-control": CACHE_CONTROL,
      etag,
    };
    if (matchesETag(request.headers.get("if-none-match"), etag)) {
      return new Response(null, { status: 304, headers });
    }
    return new Response(body, {
      headers: { ...headers, "content-type": "application/javascript; charset=utf-8" },
    });
  };
}
