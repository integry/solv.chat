import { isRetryableStatus, ProviderError, toProviderError } from "./error.js";
import { readEventStream } from "./sse.js";
import { parseToolInput } from "./toolInput.js";
import type { LlmMessage, LlmProvider, StopReason, ToolDefinition } from "./types.js";

export interface OpenAiOptions {
  apiKey: string;
  model: string;
  fetchImpl?: typeof fetch | undefined;
}

// Source: https://developers.openai.com/api/docs/models and
// https://developers.openai.com/api/docs/api-reference/responses/create — checked 2026-11-15
const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";

interface OpenAiResponsePayload {
  type?: string;
  delta?: string;
  item_id?: string;
  arguments?: string;
  item?: {
    type?: string;
    id?: string;
    call_id?: string;
    name?: string;
    arguments?: string;
  };
  response?: {
    status?: string;
    incomplete_details?: {
      reason?: string;
    } | null;
    output?: Array<{
      type?: string;
    }>;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
    } | null;
    error?: {
      code?: string;
      type?: string;
    } | null;
  };
  code?: string;
  error?: {
    type?: string;
    code?: string;
  };
}

function readUsage(usage: NonNullable<OpenAiResponsePayload["response"]>["usage"]): {
  tokensIn?: number;
  tokensOut?: number;
} {
  if (!usage) return {};
  const out: { tokensIn?: number; tokensOut?: number } = {};
  if (typeof usage.input_tokens === "number" && Number.isFinite(usage.input_tokens)) {
    out.tokensIn = usage.input_tokens;
  }
  if (typeof usage.output_tokens === "number" && Number.isFinite(usage.output_tokens)) {
    out.tokensOut = usage.output_tokens;
  }
  return out;
}

function consumePendingToolCall(
  pending: Map<string, { callId: string; name: string; json: string }>,
  itemId: string | undefined,
  fallbackArgs: string | undefined,
) {
  if (typeof itemId !== "string") return undefined;
  const open = pending.get(itemId);
  if (!open) return undefined;
  pending.delete(itemId);
  const raw =
    open.json.length > 0 ? open.json : typeof fallbackArgs === "string" ? fallbackArgs : "";
  return {
    callId: open.callId,
    name: open.name,
    input: parseToolInput("openai", raw),
  };
}

/** Creates an OpenAI Responses API streaming provider. */
export function openaiProvider(options: OpenAiOptions): LlmProvider {
  const doFetch = options.fetchImpl ?? fetch;

  return {
    name: "openai",
    model: options.model,
    async *stream(request) {
      let response: Response;
      try {
        response = await doFetch(OPENAI_RESPONSES_URL, {
          method: "POST",
          headers: {
            authorization: `Bearer ${options.apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: options.model,
            ...(request.system.length > 0 ? { instructions: request.system } : {}),
            input: toResponsesInput(request.messages),
            max_output_tokens: request.maxTokens,
            stream: true,
            // Absent when no tool is allowed, matching phase 1's no-tools invariant.
            ...(request.tools && request.tools.length > 0
              ? { tools: request.tools.map(toResponsesTool) }
              : {}),
          }),
        });
      } catch (err) {
        throw toProviderError(err, "openai request failed");
      }

      if (!response.ok || response.body === null) {
        throw new ProviderError(
          `openai request failed with ${response.status}`,
          isRetryableStatus(response.status),
          response.status,
        );
      }

      let tokensIn: number | undefined;
      let tokensOut: number | undefined;
      let sawTerminal = false;
      let sawToolCall = false;
      let stopReason: StopReason | undefined;
      let failure: ProviderError | undefined;
      // Tool arguments arrive as fragments keyed by the Responses API `item_id`.
      // Buffer per item and parse once the call is complete.
      const pending = new Map<string, { callId: string; name: string; json: string }>();

      try {
        for await (const event of readEventStream(response.body)) {
          const payload = event.data as OpenAiResponsePayload;
          const eventType = event.event ?? payload.type;

          if (eventType === "error" || payload.error) {
            const errorType = payload.error?.type ?? payload.error?.code ?? payload.code;
            throw new ProviderError(
              `openai stream error: ${errorType ?? "unknown"}`,
              errorType !== "invalid_request_error",
            );
          }

          if (eventType === "response.failed") {
            const reported = readUsage(payload.response?.usage);
            if (reported.tokensIn !== undefined) tokensIn = reported.tokensIn;
            if (reported.tokensOut !== undefined) tokensOut = reported.tokensOut;
            const errorCode = payload.response?.error?.code ?? payload.response?.error?.type;
            throw new ProviderError(
              `openai response failed: ${errorCode ?? "unknown"}`,
              errorCode !== "invalid_request_error",
            );
          }

          if (eventType === "response.output_text.delta") {
            if (typeof payload.delta === "string" && payload.delta.length > 0) {
              yield { kind: "text", text: payload.delta };
            }
            continue;
          }

          if (eventType === "response.output_item.added") {
            const item = payload.item;
            if (
              item?.type === "function_call" &&
              typeof item.id === "string" &&
              typeof item.call_id === "string" &&
              typeof item.name === "string"
            ) {
              pending.set(item.id, { callId: item.call_id, name: item.name, json: "" });
            }
            continue;
          }

          if (eventType === "response.function_call_arguments.delta") {
            if (typeof payload.item_id === "string" && typeof payload.delta === "string") {
              const open = pending.get(payload.item_id);
              if (open) open.json += payload.delta;
            }
            continue;
          }

          if (
            eventType === "response.function_call_arguments.done" ||
            eventType === "response.output_item.done"
          ) {
            const itemId =
              eventType === "response.function_call_arguments.done"
                ? payload.item_id
                : payload.item?.type === "function_call"
                  ? payload.item.id
                  : undefined;
            const fallbackArgs =
              eventType === "response.function_call_arguments.done"
                ? payload.arguments
                : payload.item?.arguments;
            const call = consumePendingToolCall(pending, itemId, fallbackArgs);
            if (call) {
              sawToolCall = true;
              yield { kind: "tool_call", call };
            }
            continue;
          }

          if (eventType === "response.completed" || eventType === "response.incomplete") {
            sawTerminal = true;
            const reported = readUsage(payload.response?.usage);
            if (reported.tokensIn !== undefined) tokensIn = reported.tokensIn;
            if (reported.tokensOut !== undefined) tokensOut = reported.tokensOut;

            if (eventType === "response.incomplete") {
              const reason = payload.response?.incomplete_details?.reason;
              stopReason =
                reason === "max_output_tokens" ? "length" : sawToolCall ? "tools" : "end";
            } else {
              const hasOutputCall =
                sawToolCall ||
                Boolean(payload.response?.output?.some((item) => item.type === "function_call"));
              stopReason = hasOutputCall ? "tools" : "end";
            }
          }
        }
      } catch (err) {
        failure = toProviderError(err, "openai stream failed");
      }

      // A stream stopping without its terminal event truncated the answer;
      // throwing lets the chat endpoint say so instead of presenting half an
      // answer as complete.
      if (failure === undefined && !sawTerminal) {
        failure = new ProviderError("openai stream ended early", true);
      }
      if (failure === undefined && (tokensIn === undefined || tokensOut === undefined)) {
        failure = new ProviderError("openai stream ended without usage", true);
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

// Source: https://developers.openai.com/api/docs/guides/function-calling — checked 2026-11-15
function toResponsesTool(tool: ToolDefinition) {
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
  };
}

/**
 * Translates the shared message list into Responses API `input` items.
 * Tool calls and their outputs are top-level items matched by `call_id`.
 */
function toResponsesInput(messages: readonly LlmMessage[]) {
  const items: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    if (message.role === "tool_results") {
      for (const result of message.results) {
        items.push({
          type: "function_call_output",
          call_id: result.callId,
          output: result.content,
        });
      }
      continue;
    }
    if ("toolCalls" in message) {
      if (message.content !== "") {
        items.push({ role: "assistant", content: message.content });
      }
      for (const call of message.toolCalls) {
        items.push({
          type: "function_call",
          call_id: call.callId,
          name: call.name,
          arguments: JSON.stringify(call.input),
        });
      }
      continue;
    }
    items.push({ role: message.role, content: message.content });
  }
  return items;
}
