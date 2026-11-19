import { EmptyReplyError, isRetryableStatus, ProviderError, toProviderError } from "./error.js";
import { type ReasoningSwitchState, sendWithReasoningSwitch } from "./reasoning.js";
import { readEventStream } from "./sse.js";
import type { LlmProvider } from "./types.js";

export interface OpenRouterOptions {
  apiKey: string;
  model: string;
  httpReferer?: string | undefined;
  title?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
}

// Source: https://openrouter.ai/docs/api-reference/chat-completion — checked 2026-11-15
const OPENROUTER_CHAT_COMPLETIONS_URL = "https://openrouter.ai/api/v1/chat/completions";

// Source: https://openrouter.ai/docs/app-attribution — checked 2026-11-15
export const OPENROUTER_DEFAULT_REFERER = "https://solv.chat";
export const OPENROUTER_DEFAULT_TITLE = "solv.chat";

// Source: https://openrouter.ai/docs/api-reference/streaming and https://openrouter.ai/docs/use-cases/usage-accounting — checked 2026-11-15
// OpenRouter includes `usage` (with `cost` in credits when available) in the final
// streamed chunk automatically; `stream_options` is deprecated and has no effect.
// Source: https://openrouter.ai/docs/api-reference/errors — checked 2026-11-15
// Mid-stream errors arrive in an SSE chunk with an `error` object (and typically
// `finish_reason: "error"`).
interface OpenRouterChunkPayload {
  choices?: Array<{
    delta?: {
      content?: string | null;
      reasoning?: string | null;
      reasoning_details?: unknown[] | null;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    completion_tokens_details?: {
      reasoning_tokens?: number | null;
    } | null;
    cost?: number | null;
  } | null;
  error?: {
    code?: number | string;
    message?: string;
  };
}

function isRetryableStreamError(code: number | string | undefined): boolean {
  if (typeof code === "number") return isRetryableStatus(code);
  return code !== "invalid_request_error";
}

function formatStreamErrorMessage(code: number | string | undefined): string {
  if (typeof code === "number" && Number.isInteger(code) && code >= 100 && code <= 599) {
    return `openrouter stream error: ${code}`;
  }
  return "openrouter stream error";
}

/** Creates an OpenRouter Chat Completions streaming provider. */
export function openrouterProvider(options: OpenRouterOptions): LlmProvider {
  const doFetch = options.fetchImpl ?? fetch;
  const httpReferer = options.httpReferer ?? OPENROUTER_DEFAULT_REFERER;
  const title = options.title ?? OPENROUTER_DEFAULT_TITLE;
  const switchState: ReasoningSwitchState = { refused: false };

  return {
    name: "openrouter",
    model: options.model,
    async *stream(request, streamOptions) {
      const messages =
        request.system.length > 0
          ? [{ role: "system" as const, content: request.system }, ...request.messages]
          : [...request.messages];

      let response: Response;
      try {
        response = await sendWithReasoningSwitch(request, switchState, true, (off, maxTokens) =>
          doFetch(OPENROUTER_CHAT_COMPLETIONS_URL, {
            method: "POST",
            ...(streamOptions?.signal ? { signal: streamOptions.signal } : {}),
            headers: {
              authorization: `Bearer ${options.apiKey}`,
              "content-type": "application/json",
              "http-referer": httpReferer,
              "x-title": title,
            },
            body: JSON.stringify({
              model: options.model,
              messages,
              max_tokens: maxTokens,
              stream: true,
              // Only for `reasoning: "off"`: `effort: "none"` "Disables
              // reasoning entirely". Reasoning tokens are output tokens and
              // count against the limit. A model whose reasoning is mandatory
              // rejects it; that 400 is asked again without it and with a
              // larger limit (`sendWithReasoningSwitch`).
              // Source: https://openrouter.ai/docs/use-cases/reasoning-tokens — checked 2026-11-19
              ...(off ? { reasoning: { effort: "none" } } : {}),
            }),
          }),
        );
      } catch (err) {
        throw toProviderError(err, "openrouter request failed");
      }

      if (!response.ok || response.body === null) {
        // Never forward the response body: it may echo request content or key metadata.
        throw new ProviderError(
          `openrouter request failed with ${response.status}`,
          isRetryableStatus(response.status),
          response.status,
        );
      }

      let tokensIn: number | undefined;
      let tokensOut: number | undefined;
      let costMicros: number | undefined;
      let sawTerminal = false;
      let failure: ProviderError | undefined;
      // A reply is text; reasoning alone is not one.
      let sawText = false;
      let sawReasoning = false;

      try {
        for await (const event of readEventStream(response.body, streamOptions?.signal)) {
          const payload = event.data as OpenRouterChunkPayload;

          if (payload.usage) {
            const promptTokens = payload.usage.prompt_tokens;
            if (typeof promptTokens === "number" && Number.isFinite(promptTokens)) {
              tokensIn = promptTokens;
            }
            const completionTokens = payload.usage.completion_tokens;
            if (typeof completionTokens === "number" && Number.isFinite(completionTokens)) {
              tokensOut = completionTokens;
            }
            const reasoningTokens = payload.usage.completion_tokens_details?.reasoning_tokens;
            if (typeof reasoningTokens === "number" && reasoningTokens > 0) sawReasoning = true;
            // Source: https://openrouter.ai/docs/use-cases/usage-accounting — checked 2026-11-15
            // `usage.cost` is reported in OpenRouter credits; stored as micro-credits (10^-6).
            const costCredits = payload.usage.cost;
            if (
              typeof costCredits === "number" &&
              Number.isFinite(costCredits) &&
              costCredits >= 0
            ) {
              costMicros = Math.round(costCredits * 1_000_000);
            }
          }

          if (payload.error) {
            const code = payload.error.code;
            throw new ProviderError(formatStreamErrorMessage(code), isRetryableStreamError(code));
          }

          const choice = payload.choices?.[0];
          // Source: https://openrouter.ai/docs/use-cases/reasoning-tokens — checked 2026-11-19
          // (`choices[].delta.reasoning_details` per chunk; `reasoning` on messages).
          const details = choice?.delta?.reasoning_details;
          if (
            (Array.isArray(details) && details.length > 0) ||
            (typeof choice?.delta?.reasoning === "string" && choice.delta.reasoning.length > 0)
          ) {
            sawReasoning = true;
          }
          if (typeof choice?.delta?.content === "string" && choice.delta.content.length > 0) {
            sawText = true;
            yield { kind: "text", text: choice.delta.content };
          }
          if (choice?.finish_reason !== undefined && choice.finish_reason !== null) {
            sawTerminal = true;
          }
        }
      } catch (err) {
        failure = toProviderError(err, "openrouter stream failed");
      }

      if (failure === undefined && !sawTerminal) {
        failure = new ProviderError("openrouter stream ended early", true);
      }
      if (failure === undefined && (tokensIn === undefined || tokensOut === undefined)) {
        failure = new ProviderError("openrouter stream ended without usage", true);
      }
      // This provider streams no tool calls, so a reply is text only.
      if (failure === undefined && sawReasoning && !sawText) {
        failure = new EmptyReplyError("openrouter");
      }

      if (tokensIn !== undefined || tokensOut !== undefined || costMicros !== undefined) {
        yield {
          kind: "usage",
          tokensIn: tokensIn ?? 0,
          tokensOut: tokensOut ?? 0,
          ...(costMicros !== undefined ? { costMicros } : {}),
        };
      }
      if (failure !== undefined) throw failure;
    },
  };
}
