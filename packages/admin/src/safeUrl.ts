/**
 * True for absolute `http(s)` URLs only. Citation links are rendered as
 * `href`, and a `javascript:` or `data:` URL there would run in the admin's
 * origin; ingest already refuses them, so this is a second line of defence.
 */
export function isSafeHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}
