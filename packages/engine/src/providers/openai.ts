import { isRetryableStatus, ProviderError } from "./error.js";
import { readEventStream } from "./sse.js";
import type { LlmProvider } from "./types.js";

export interface OpenAiOptions {
  apiKey: string;
  model: string;
  fetchImpl?: typeof fetch | undefined;
}

// Source: https://platform.openai.com/docs/api-reference/chat/create — checked 2026-11-14
const OPENAI_CHAT_COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions";

interface OpenAiChunkPayload {
  choices?: Array<{
    delta?: {
      content?: string | null;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  } | null;
  error?: {
    type?: string;
  };
}

/** Creates an OpenAI Chat Completions streaming provider. */
export function openaiProvider(options: OpenAiOptions): LlmProvider {
  const doFetch = options.fetchImpl ?? fetch;

  return {
    name: "openai",
    model: options.model,
    async *stream(request) {
      const messages =
        request.system.length > 0
          ? [{ role: "system" as const, content: request.system }, ...request.messages]
          : [...request.messages];

      const response = await doFetch(OPENAI_CHAT_COMPLETIONS_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: options.model,
          messages,
          max_completion_tokens: request.maxTokens,
          stream: true,
          stream_options: { include_usage: true },
        }),
      });

      if (!response.ok || response.body === null) {
        throw new ProviderError(
          `openai request failed with ${response.status}`,
          isRetryableStatus(response.status),
          response.status,
        );
      }

      let tokensIn = 0;
      let tokensOut = 0;
      let sawTerminal = false;

      for await (const event of readEventStream(response.body)) {
        const payload = event.data as OpenAiChunkPayload;

        if (payload.error) {
          const errorType = payload.error.type;
          throw new ProviderError(
            `openai stream error: ${errorType ?? "unknown"}`,
            errorType !== "invalid_request_error",
          );
        }

        const choice = payload.choices?.[0];
        if (typeof choice?.delta?.content === "string" && choice.delta.content.length > 0) {
          yield { kind: "text", text: choice.delta.content };
        }
        if (choice?.finish_reason !== undefined && choice.finish_reason !== null) {
          sawTerminal = true;
        }

        if (payload.usage) {
          if (typeof payload.usage.prompt_tokens === "number") {
            tokensIn = payload.usage.prompt_tokens;
          }
          if (typeof payload.usage.completion_tokens === "number") {
            tokensOut = payload.usage.completion_tokens;
          }
        }
      }

      if (!sawTerminal) {
        throw new ProviderError("openai stream ended early", true);
      }

      yield { kind: "usage", tokensIn, tokensOut };
    },
  };
}
