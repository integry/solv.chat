import { sha256Hex } from "./crypto.js";
import { matchesETag } from "./etag.js";

const CACHE_CONTROL = "public, max-age=300, must-revalidate, no-transform";

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
