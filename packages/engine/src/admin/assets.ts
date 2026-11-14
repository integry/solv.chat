import { ADMIN_ASSETS, ADMIN_HTML } from "../adminBundle.js";

/**
 * Serves the admin bundle. Any unmatched /admin path returns index.html so
 * client-side routing works on a deep link or a refresh, except unknown asset
 * paths under /admin/assets/ which return 404.
 *
 * no-store on the HTML and a long max-age on hashed assets: the HTML names the
 * current asset hashes, so a cached HTML would keep an owner on an old build
 * indefinitely, while hashed files can never be stale by definition.
 */
export function adminAsset(url: URL): Response {
  const asset = ADMIN_ASSETS[url.pathname];
  if (asset !== undefined) {
    return new Response(asset.body, {
      headers: {
        "content-type": asset.type,
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
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
      },
    });
  }
  return Response.json({ error: "Not found." }, { status: 404 });
}
