import type { LlmRequest } from "./types.js";

/**
 * The output limit for a `reasoning: "off"` call whose model refused the
 * switch (400) and is asked again without it. Every provider counts
 * reasoning against the output limit (Anthropic: "thinking tokens count
 * toward max_tokens"; OpenAI: "Reasoning tokens count against
 * max_output_tokens"; OpenRouter: the limit "applies to reasoning and visible
 * output combined"), so a small limit can then be spent before any reply is
 * written. Ours, from those pages: enough for a short reasoning pass and a
 * one-line reply; only what is generated is billed.
 * Source: https://platform.claude.com/docs/en/build-with-claude/thinking-steering-and-cost,
 * https://developers.openai.com/api/docs/guides/reasoning and
 * https://openrouter.ai/docs/use-cases/reasoning-tokens — checked 2026-11-19
 */
export const REASONING_FALLBACK_MIN_OUTPUT_TOKENS = 4096;

/**
 * Remembers, per provider instance, that the model refused the switch, so
 * later calls do not pay for a refused request first.
 */
export interface ReasoningSwitchState {
  refused: boolean;
}

/**
 * Sends `request`, with the provider's "no reasoning" switch when it asks for
 * `reasoning: "off"`. `send(off, maxTokens)` builds and posts the body; `off`
 * is false when the switch must be left out. `canSwitchOff` is false for a
 * model known to refuse it (thinking always on), which skips straight to the
 * fallback. A 400 to a request that carried the switch is taken as the model
 * refusing it: the body is dropped unread (never forwarded) and the request
 * sent once more without the switch, with at least
 * `REASONING_FALLBACK_MIN_OUTPUT_TOKENS`. A request without `reasoning` is
 * sent exactly as before.
 */
export async function sendWithReasoningSwitch(
  request: LlmRequest,
  state: ReasoningSwitchState,
  canSwitchOff: boolean,
  send: (off: boolean, maxTokens: number) => Promise<Response>,
): Promise<Response> {
  if (request.reasoning !== "off") return send(false, request.maxTokens);
  const fallbackTokens = Math.max(request.maxTokens, REASONING_FALLBACK_MIN_OUTPUT_TOKENS);
  if (!canSwitchOff || state.refused) return send(false, fallbackTokens);
  const response = await send(true, request.maxTokens);
  if (response.status !== 400) return response;
  state.refused = true;
  await response.body?.cancel().catch(() => undefined);
  return send(false, fallbackTokens);
}
