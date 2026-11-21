import { isPlainObject, parseUrl } from "./shared.js";

export type McpAuthKind = "none" | "static_header";
export type ToolCredentialSource = "owner" | "page";

export interface PageToolServer {
  serverId: string;
  url: string;
  headerName: string;
}

export type ToolCredentials = Record<string, string>;

export const MAX_TOOL_CREDENTIALS = 8;
export const MAX_TOOL_TOKEN_LENGTH = 4096;

/** A public endpoint identifier, without URL user info, a query or a fragment. */
export function toolCredentialUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  const url = parseUrl(value, ["https:"]);
  return url && url.href === url.origin + url.pathname ? url.href : null;
}

const RESERVED_TOOL_HEADERS = new Set([
  "host",
  "content-length",
  "content-type",
  "accept",
  "connection",
  "transfer-encoding",
  "solv-conversation-id",
  "solv-visitor-id",
  "solv-assistant-id",
]);

export function isToolCredentialHeader(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9-]{1,64}$/.test(value) &&
    !RESERVED_TOOL_HEADERS.has(value.toLowerCase()) &&
    !value.toLowerCase().startsWith("mcp-")
  );
}

/** HTTP header values must be nonempty and cannot contain control characters. */
export function isToolToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_TOOL_TOKEN_LENGTH &&
    value.length > 0 &&
    value.trim() === value &&
    Array.from(value).every((char) => {
      const code = char.charCodeAt(0);
      return code >= 32 && code !== 127 && code <= 255;
    })
  );
}

export function parseToolCredentials(value: unknown): ToolCredentials | null {
  if (!isPlainObject(value)) return null;
  const entries = Object.entries(value);
  if (entries.length > MAX_TOOL_CREDENTIALS) return null;
  const credentials: ToolCredentials = {};
  for (const [key, token] of entries) {
    const url = toolCredentialUrl(key);
    if (url === null || !isToolToken(token) || Object.hasOwn(credentials, url)) return null;
    credentials[url] = token;
  }
  return credentials;
}
