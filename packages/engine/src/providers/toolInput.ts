import { ProviderError } from "./error.js";

/**
 * Parses accumulated tool-input JSON once a provider's tool call block closes.
 * Empty input (e.g. a zero-argument tool) normalizes to `{}`. Throws a
 * non-retryable `ProviderError` without echoing the raw payload, which may
 * quote untrusted page or message content.
 */
export function parseToolInput(provider: string, rawJson: string): Record<string, unknown> {
  const raw = rawJson.trim() === "" ? "{}" : rawJson;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ProviderError(`${provider} sent unparsable tool input`, false);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ProviderError(`${provider} sent non-object tool input`, false);
  }
  return parsed as Record<string, unknown>;
}
