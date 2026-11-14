export type LlmChunk =
  | { kind: "text"; text: string }
  | { kind: "usage"; tokensIn: number; tokensOut: number };

export interface LlmMessage {
  role: "user" | "assistant";
  content: string;
}

export interface LlmRequest {
  system: string;
  messages: readonly LlmMessage[];
  maxTokens: number;
}

export interface LlmProvider {
  readonly name: "anthropic" | "openai";
  readonly model: string;
  /**
   * Streaming only. A non-streaming method would be a second code path to
   * test for no gain: the widget streams and "Try it" reuses the endpoint.
   * Phase 2 adds tools as an optional field on LlmRequest, which no current
   * caller has to change.
   */
  stream(request: LlmRequest): AsyncIterable<LlmChunk>;
}
