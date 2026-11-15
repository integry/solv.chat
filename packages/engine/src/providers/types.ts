/**
 * One tool the model may ask for. `inputSchema` is a JSON Schema object; it
 * comes from an MCP server's tool list or from a page action registration, so
 * it is owner- or page-supplied data and is passed through, never executed.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** A tool the model asked for, with the id the provider will match results to. */
export interface ToolCall {
  callId: string;
  name: string;
  input: Record<string, unknown>;
}

/**
 * Why the stream ended. The tool loop needs to tell "the model finished" from
 * "the model is waiting for tool results"; without it the loop would have to
 * guess from whether a tool_call chunk arrived, which breaks the moment a
 * provider streams text after a call.
 */
export type StopReason = "end" | "tools" | "length";

export type LlmChunk =
  | { kind: "text"; text: string }
  | { kind: "tool_call"; call: ToolCall }
  // stopReason is optional so a provider that cannot report one stays valid
  // and phase 1 callers, which ignore the field, are unaffected.
  | {
      kind: "usage";
      tokensIn: number;
      tokensOut: number;
      stopReason?: StopReason;
      costMicros?: number | undefined;
    };

/**
 * A turn in the conversation. The first two shapes are phase 1 and unchanged,
 * so existing literals stay assignable. The two added shapes carry a tool
 * exchange: the assistant turn that asked, and the results going back.
 *
 * Results are a separate role rather than text appended to a user message:
 * both provider APIs require them to be matched to the call by id, and
 * flattening them into prose would also make a tool result look like
 * something the visitor said.
 */
export type LlmMessage =
  | { role: "user" | "assistant"; content: string }
  | { role: "assistant"; content: string; toolCalls: readonly ToolCall[] }
  | { role: "tool_results"; results: readonly LlmToolResult[] };

export interface LlmToolResult {
  callId: string;
  /** Already truncated by the caller; providers must not grow it. */
  content: string;
  isError: boolean;
}

export interface LlmRequest {
  system: string;
  messages: readonly LlmMessage[];
  maxTokens: number;
  /**
   * Omitted or empty means "no tools": providers omit `tools` from the
   * request body, so nothing about answering from content changes when no tool
   * is allowed.
   */
  tools?: readonly ToolDefinition[] | undefined;
}

export interface LlmProvider {
  readonly name: "anthropic" | "openai" | "openrouter";
  readonly model: string;
  /**
   * Streaming only. A non-streaming method would be a second code path to
   * test for no gain: the widget streams and "Try it" reuses the endpoint.
   * Phase 2 adds tools as an optional field on LlmRequest, which no current
   * caller has to change.
   */
  stream(
    request: LlmRequest,
    options?: { signal?: AbortSignal | undefined },
  ): AsyncIterable<LlmChunk>;
}
