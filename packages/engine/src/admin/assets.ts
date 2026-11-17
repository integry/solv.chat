import { ADMIN_CSP, ADMIN_PREVIEW_CSP } from "@solvchat/core";
import { ADMIN_ASSETS, ADMIN_HTML } from "../adminBundle.js";

export interface AdminAssetEntry {
  body: string;
  type: string;
  /** Binary files are stored base64 by `scripts/sync-admin.mjs`. */
  encoding: "utf8" | "base64";
}

/** The bytes to serve for a bundled asset, decoding base64 for binary files. */
export function assetBody(asset: AdminAssetEntry): string | ArrayBuffer {
  if (asset.encoding !== "base64") return asset.body;
  const binary = atob(asset.body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/** The Widget screen's preview page: unhashed, so it is revalidated, not cached for a year. */
const PREVIEW_PAGE = "/admin/preview.html";

/**
 * Serves the admin bundle. Any unmatched /admin path returns index.html so
 * client-side routing works on a deep link or a refresh, except unknown asset
 * paths under /admin/assets/ which return 404.
 *
 * no-store on the HTML and a long max-age on hashed assets: the HTML names the
 * current asset hashes, so a cached HTML would keep an owner on an old build
 * indefinitely, while hashed files can never be stale by definition. Files
 * outside /admin/assets/ (the Widget preview page, script and stylesheet) keep
 * the same name across builds, so they are revalidated on every load.
 */
export function adminAsset(url: URL): Response {
  const asset: AdminAssetEntry | undefined = ADMIN_ASSETS[url.pathname];
  if (asset !== undefined) {
    const headers: Record<string, string> = {
      "content-type": asset.type,
      "cache-control": url.pathname.startsWith("/admin/assets/")
        ? "public, max-age=31536000, immutable"
        : "no-cache",
    };
    if (url.pathname === PREVIEW_PAGE) {
      headers["x-content-type-options"] = "nosniff";
      headers["referrer-policy"] = "same-origin";
      // Only the admin may frame it; the page repeats the rest in a <meta>.
      headers["content-security-policy"] = `${ADMIN_PREVIEW_CSP}; frame-ancestors 'self'`;
    }
    return new Response(assetBody(asset), { headers });
  }
  if (url.pathname.startsWith("/admin/assets/")) {
    return Response.json({ error: "Not found." }, { status: 404 });
  }
  if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
    // The shell holds no owner data — the app fetches everything through the
    // authenticated API — so serving it unauthenticated leaks nothing.
    return new Response(ADMIN_HTML, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "referrer-policy": "same-origin",
        "x-frame-options": "DENY",
        "content-security-policy": ADMIN_CSP,
      },
    });
  }
  return Response.json({ error: "Not found." }, { status: 404 });
}
