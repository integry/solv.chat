/**
 * Content-Security-Policy for the admin's HTML shell. Shared so the engine
 * serves it and the admin's browser test runs the app under the same policy.
 *
 * `frame-src 'self'` is for the Widget screen's live preview, a same-origin
 * static page (`/admin/preview.html`) in a sandboxed frame.
 */
export const ADMIN_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'self'",
  "frame-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/**
 * Policy for the preview page inside that frame: the widget script, the
 * preview script and stylesheet from this origin, and nothing else. No
 * `connect-src`, so nothing in the frame can make a request. The page also
 * carries it as a `<meta>` tag, so an embedder serving the file with its own
 * admin policy still gets these limits.
 */
export const ADMIN_PREVIEW_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");
