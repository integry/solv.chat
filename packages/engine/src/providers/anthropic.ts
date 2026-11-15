import { isRetryableStatus, ProviderError, toProviderError } from "./error.js";
import { readEventStream } from "./sse.js";
import { parseToolInput } from "./toolInput.js";
import type { LlmMessage, LlmProvider, StopReason, ToolDefinition } from "./types.js";

export interface AnthropicOptions {
  apiKey: string;
  model: string;
  fetchImpl?: typeof fetch | undefined;
}

// Source: https://platform.claude.com/docs/en/api/messages-streaming and
// https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview — checked 2026-11-15
const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2026-10-21";

interface AnthropicEventPayload {
  type?: string;
  index?: number;
  message?: {
    usage?: {
      input_tokens?: number;
    };
  };
  content_block?: {
    type?: string;
    id?: string;
    name?: string;
  };
  delta?: {
    type?: string;
    text?: string;
    partial_json?: string;
    stop_reason?: string;
  };
  usage?: {
    output_tokens?: number;
  };
  error?: {
    type?: string;
  };
}

function isRetryableStreamError(errorType: string | undefined): boolean {
  return (
    errorType === "overloaded_error" ||
    errorType === "rate_limit_error" ||
    errorType === "api_error"
  );
}

/** Creates an Anthropic Messages API streaming provider. */
export function anthropicProvider(options: AnthropicOptions): LlmProvider {
  // Injected so tests drive the parser from canned bytes; the default keeps
  // production wiring a one-liner.
  const doFetch = options.fetchImpl ?? fetch;

  return {
    name: "anthropic",
    model: options.model,
    async *stream(request, streamOptions) {
      let response: Response;
      try {
        response = await doFetch(ANTHROPIC_MESSAGES_URL, {
          method: "POST",
          ...(streamOptions?.signal ? { signal: streamOptions.signal } : {}),
          headers: {
            // Header only: never a query string, which ends up in logs we do not
            // control.
            "x-api-key": options.apiKey,
            "anthropic-version": ANTHROPIC_VERSION,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: options.model,
            system: request.system,
            messages: toAnthropicMessages(request.messages),
            max_tokens: request.maxTokens,
            stream: true,
            // Absent when no tool is allowed, so the body stays byte-identical
            // to phase 1 and the existing request-shape test still holds.
            ...(request.tools && request.tools.length > 0
              ? { tools: request.tools.map(toAnthropicTool) }
              : {}),
          }),
        });
      } catch (err) {
        throw toProviderError(err, "anthropic request failed");
      }

      if (!response.ok || response.body === null) {
        // The provider's error body is not forwarded: it can echo request
        // content, and this message reaches a log the owner may share.
        throw new ProviderError(
          `anthropic request failed with ${response.status}`,
          isRetryableStatus(response.status),
          response.status,
        );
      }

      let tokensIn: number | undefined;
      let tokensOut: number | undefined;
      let sawTerminal = false;
      let failure: ProviderError | undefined;
      let toolInputFailure: ProviderError | undefined;
      let stopReason: StopReason | undefined;
      // Tool input arrives as a stream of JSON fragments, keyed by the
      // content block index. Buffer per block and parse once at the block
      // boundary: half an object cannot be validated, and handing fragments
      // to the caller would leak provider framing into the tool loop.
      const pending = new Map<number, { callId: string; name: string; json: string }>();

      try {
        for await (const event of readEventStream(response.body, streamOptions?.signal)) {
          const payload = event.data as AnthropicEventPayload;
          const eventType = event.event ?? payload.type;

          if (eventType === "error") {
            const errorType = payload.error?.type;
            throw new ProviderError(
              `anthropic stream error: ${errorType ?? "unknown"}`,
              isRetryableStreamError(errorType),
            );
          }

          if (eventType === "message_start") {
            const inputTokens = payload.message?.usage?.input_tokens;
            if (typeof inputTokens === "number" && Number.isFinite(inputTokens)) {
              tokensIn = inputTokens;
            }
            continue;
          }

          if (eventType === "content_block_start") {
            const block = payload.content_block;
            if (
              block?.type === "tool_use" &&
              typeof block.id === "string" &&
              typeof block.name === "string" &&
              payload.index !== undefined
            ) {
              pending.set(payload.index, { callId: block.id, name: block.name, json: "" });
            }
            continue;
          }

          if (eventType === "content_block_delta") {
            if (payload.delta?.type === "text_delta" && typeof payload.delta.text === "string") {
              yield { kind: "text", text: payload.delta.text };
            }
            if (
              payload.delta?.type === "input_json_delta" &&
              typeof payload.delta.partial_json === "string" &&
              payload.index !== undefined
            ) {
              const open = pending.get(payload.index);
              if (open) open.json += payload.delta.partial_json;
            }
            continue;
          }

          if (eventType === "content_block_stop" && payload.index !== undefined) {
            const open = pending.get(payload.index);
            if (open) {
              pending.delete(payload.index);
              // Defer input-parse failures until terminal metadata arrives:
              // max_tokens truncation can close a tool block mid-JSON, and
              // completed malformed calls still owe the caller any reported usage.
              try {
                const input = parseToolInput("anthropic", open.json);
                yield {
                  kind: "tool_call",
                  call: {
                    callId: open.callId,
                    name: open.name,
                    input,
                  },
                };
              } catch (err) {
                toolInputFailure ??= toProviderError(err, "anthropic stream failed");
              }
            }
            continue;
          }

          if (eventType === "message_delta") {
            const outputTokens = payload.usage?.output_tokens;
            if (typeof outputTokens === "number" && Number.isFinite(outputTokens)) {
              tokensOut = outputTokens;
            }
            if (payload.delta?.stop_reason === "tool_use") stopReason = "tools";
            else if (payload.delta?.stop_reason === "max_tokens") stopReason = "length";
            else if (typeof payload.delta?.stop_reason === "string") stopReason = "end";
            continue;
          }

          if (eventType === "message_stop") {
            sawTerminal = true;
            break;
          }
        }
      } catch (err) {
        failure = toProviderError(err, "anthropic stream failed");
      }

      // Token-limit truncation explains an incomplete tool input, so suppress
      // the deferred parse error and surface stopReason: "length" instead.
      if (stopReason !== "length" && toolInputFailure !== undefined) {
        failure ??= toolInputFailure;
      }

      // A stream stopping without its terminal event truncated the answer;
      // throwing lets the chat endpoint say so instead of presenting half an
      // answer as complete.
      if (failure === undefined && !sawTerminal) {
        failure = new ProviderError("anthropic stream ended early", true);
      }
      if (failure === undefined && (tokensIn === undefined || tokensOut === undefined)) {
        failure = new ProviderError("anthropic stream ended without usage", true);
      }

      // Counts the provider has already reported are billed whether or not the
      // stream completes, so they are handed to the caller before any failure
      // propagates. Exactly one usage chunk per stream; a count never reported
      // is 0, the only figure that is not a guess.
      if (tokensIn !== undefined || tokensOut !== undefined) {
        yield {
          kind: "usage",
          tokensIn: tokensIn ?? 0,
          tokensOut: tokensOut ?? 0,
          ...(stopReason !== undefined ? { stopReason } : {}),
        };
      }
      if (failure !== undefined) throw failure;
    },
  };
}

// Source: https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview — checked 2026-11-15
function toAnthropicTool(tool: ToolDefinition) {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  };
}

/**
 * Translates the shared message list into Anthropic content blocks. Phase 1
 * messages pass through as plain strings, so a conversation with no tool
 * exchange serialises exactly as before.
 */
function toAnthropicMessages(messages: readonly LlmMessage[]) {
  return messages.map((message) => {
    if (message.role === "tool_results") {
      // Results travel in a user-role turn, as the API requires, but as
      // tool_result blocks rather than prose: a result is data to read, never
      // instructions.
      return {
        role: "user" as const,
        content: message.results.map((result) => ({
          type: "tool_result",
          tool_use_id: result.callId,
          content: result.content,
          ...(result.isError ? { is_error: true } : {}),
        })),
      };
    }
    if ("toolCalls" in message) {
      return {
        role: "assistant" as const,
        content: [
          ...(message.content === "" ? [] : [{ type: "text", text: message.content }]),
          ...message.toolCalls.map((call) => ({
            type: "tool_use",
            id: call.callId,
            name: call.name,
            input: call.input,
          })),
        ],
      };
    }
    return { role: message.role, content: message.content };
  });
}
