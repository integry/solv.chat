import { isRetryableStatus, ProviderError } from "./error.js";
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
      const response = await doFetch(ANTHROPIC_MESSAGES_URL, {
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

      if (!response.ok || response.body === null) {
        // The provider's error body is not forwarded: it can echo request
        // content, and this message reaches a log the owner may share.
        throw new ProviderError(
          `anthropic request failed with ${response.status}`,
          isRetryableStatus(response.status),
          response.status,
        );
      }

      let tokensIn = 0;
      let tokensOut = 0;
      let sawTerminal = false;

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
          if (typeof payload.message?.usage?.input_tokens === "number") {
            tokensIn = payload.message.usage.input_tokens;
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
          if (typeof payload.usage?.output_tokens === "number") {
            tokensOut = payload.usage.output_tokens;
          }
          continue;
        }

        if (eventType === "message_stop") {
          sawTerminal = true;
          break;
        }
      }

      // A stream stopping without its terminal event truncated the answer;
      // throwing lets the chat endpoint say so instead of presenting half an
      // answer as complete.
      if (!sawTerminal) {
        throw new ProviderError("anthropic stream ended early", true);
      }

      yield { kind: "usage", tokensIn, tokensOut };
    },
  };
}
