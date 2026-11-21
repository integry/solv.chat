export function matchesETag(ifNoneMatch: string | null, etag: string): boolean {
  if (ifNoneMatch === null) return false;
  if (ifNoneMatch.trim() === "*") return true;

  // If-None-Match uses weak comparison. Commas can occur inside quoted tags.
  // https://www.rfc-editor.org/rfc/rfc9110.html#section-13.1.2
  for (const [, tag] of ifNoneMatch.matchAll(/(?:^|,)\s*(?:W\/)?("[^"]*")\s*(?=,|$)/g)) {
    if (tag === etag) return true;
  }
  return false;
}
