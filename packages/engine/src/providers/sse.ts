import { readSseBlocks } from "@solvchat/core";
import { toProviderError } from "./error.js";

export interface RawEvent {
  event?: string | undefined;
  data: unknown;
}

/**
 * Yields one provider SSE event at a time with its data parsed as JSON,
 * stopping at OpenAI's `[DONE]` sentinel. Framing and buffering are the
 * shared reader in `@solvchat/core`; a failed network read becomes a
 * `ProviderError` so callers see one error type.
 */
export async function* readEventStream(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncIterable<RawEvent> {
  for await (const block of readSseBlocks(body, {
    ...(signal ? { signal } : {}),
    mapReadError: (err) => toProviderError(err, "stream read failed"),
  })) {
    if (block.data.trim() === "[DONE]") return;
    yield { event: block.event, data: JSON.parse(block.data) as unknown };
  }
}
