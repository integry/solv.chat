/**
 * Conversation context headers: what the engine tells an owner's MCP server
 * about who a request is for, when the owner has switched "Send conversation
 * context" on for that server.
 *
 * Only the engine's own opaque ids go here. Never an IP address, a page URL,
 * message text or anything a visitor typed.
 */

/** Fixed header names. An owner's static auth header may not use any of them. */
export const CONVERSATION_ID_HEADER = "Solv-Conversation-Id";
export const VISITOR_ID_HEADER = "Solv-Visitor-Id";
export const ASSISTANT_ID_HEADER = "Solv-Assistant-Id";

export const CONVERSATION_CONTEXT_HEADER_NAMES: readonly string[] = [
  CONVERSATION_ID_HEADER,
  VISITOR_ID_HEADER,
  ASSISTANT_ID_HEADER,
];

const LOWER_NAMES = new Set(CONVERSATION_CONTEXT_HEADER_NAMES.map((n) => n.toLowerCase()));

/** True when `name` is one of the context header names, in any case. */
export function isConversationContextHeaderName(name: string): boolean {
  return LOWER_NAMES.has(name.toLowerCase());
}

/**
 * The ids sent for one request. `conversationId` and `visitorId` are present
 * only when a real conversation row exists (a visitor's chat), never for an
 * owner's preview or an answer test.
 */
export interface McpConversationContext {
  assistantId: string;
  conversationId?: string | undefined;
  visitorId?: string | undefined;
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** Hex characters kept from the SHA-256 of an id that does not fit `SAFE_ID`. */
export const CONTEXT_HASH_CHARS = 32;

/**
 * The value sent for one id: the id itself when it is 1 to 128 characters of
 * `[A-Za-z0-9_-]`, otherwise the first 32 hex characters of its SHA-256, so a
 * visitor-chosen id can never carry anything else into a header, and the same
 * id always gives the same value.
 */
export async function contextHeaderValue(id: string): Promise<string> {
  if (SAFE_ID.test(id)) return id;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(id));
  let hex = "";
  for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, "0");
  return hex.slice(0, CONTEXT_HASH_CHARS);
}

/** The headers for one context. An empty id is left out rather than sent empty. */
export async function conversationContextHeaders(
  context: McpConversationContext,
): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};
  if (context.assistantId) {
    headers[ASSISTANT_ID_HEADER] = await contextHeaderValue(context.assistantId);
  }
  if (context.conversationId) {
    headers[CONVERSATION_ID_HEADER] = await contextHeaderValue(context.conversationId);
  }
  if (context.visitorId) {
    headers[VISITOR_ID_HEADER] = await contextHeaderValue(context.visitorId);
  }
  return headers;
}
