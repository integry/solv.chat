import { isRetryableStatus, ProviderError, toProviderError } from "./error.js";
import { readEventStream } from "./sse.js";
import type { LlmProvider } from "./types.js";

export interface AnthropicOptions {
  apiKey: string;
  model: string;
  fetchImpl?: typeof fetch | undefined;
}

// Source: https://platform.claude.com/docs/en/api/messages-streaming — checked 2026-11-14
const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2026-10-21";

interface AnthropicEventPayload {
  type?: string;
  message?: {
    usage?: {
      input_tokens?: number;
    };
  };
  delta?: {
    type?: string;
    text?: string;
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
    async *stream(request) {
      let response: Response;
      try {
        response = await doFetch(ANTHROPIC_MESSAGES_URL, {
          method: "POST",
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
            messages: request.messages,
            max_tokens: request.maxTokens,
            stream: true,
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

      try {
        for await (const event of readEventStream(response.body)) {
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

          if (eventType === "content_block_delta") {
            if (payload.delta?.type === "text_delta" && typeof payload.delta.text === "string") {
              yield { kind: "text", text: payload.delta.text };
            }
            continue;
          }

          if (eventType === "message_delta") {
            const outputTokens = payload.usage?.output_tokens;
            if (typeof outputTokens === "number" && Number.isFinite(outputTokens)) {
              tokensOut = outputTokens;
            }
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
        yield { kind: "usage", tokensIn: tokensIn ?? 0, tokensOut: tokensOut ?? 0 };
      }
      if (failure !== undefined) throw failure;
    },
  };
}
