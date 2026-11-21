import type { McpAuthKind } from "@solvchat/core";
import type { McpConversationContext } from "./context.js";

export type { McpAuthKind } from "@solvchat/core";

/** Everything the client needs to reach one server. No ids, no org. */
export interface McpTarget {
  url: string;
  authKind: McpAuthKind;
  /** Header name the owner chose, for `static_header`. */
  headerName?: string | undefined;
  /**
   * Already decrypted by the caller. The client never touches
   * SOLV_SECRET_KEY: decryption belongs to the one call site that has it.
   */
  headerValue?: string | undefined;
  /** Raw page or test token, scoped to this HTTPS target. */
  pageToken?: string | undefined;
  /**
   * Set only when the owner switched "Send conversation context" on for this
   * server: every request in the session then carries the `Solv-*` headers.
   */
  conversationContext?: McpConversationContext | undefined;
}

export interface McpToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type McpFailure =
  | "unreachable"
  | "timeout"
  | "too_large"
  | "unauthorized"
  | "protocol"
  | "tool_error";

/**
 * One error type for every MCP failure, with a plain message. The server's own
 * error text is never forwarded: it can quote the request, and this message
 * reaches both an owner's screen and (for a tool error) a model prompt.
 */
export class McpError extends Error {
  readonly failure: McpFailure;

  constructor(failure: McpFailure, message: string) {
    super(message);
    this.name = "McpError";
    this.failure = failure;
  }
}
