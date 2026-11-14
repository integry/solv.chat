export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readTrimmedString(raw: unknown, min: number, max: number): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length < min || trimmed.length > max) return null;
  return trimmed;
}

export function parseUrl(
  raw: unknown,
  protocols: readonly string[] = ["https:", "http:"],
): URL | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!protocols.includes(url.protocol)) return null;
  return url;
}
