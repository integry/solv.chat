import { toProviderError } from "./error.js";

export interface RawEvent {
  event?: string | undefined;
  data: unknown;
}

function parseBlock(block: string): RawEvent | "done" | null {
  let eventName: string | undefined;
  const dataLines: string[] = [];

  for (const line of block.split("\n")) {
    if (line === "" || line.startsWith(":")) {
      continue;
    }
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) {
      value = value.slice(1);
    }
    if (field === "event") {
      eventName = value;
    } else if (field === "data") {
      dataLines.push(value);
    }
  }

  if (dataLines.length === 0) {
    return null;
  }

  const rawData = dataLines.join("\n");
  if (rawData.trim() === "[DONE]") {
    return "done";
  }

  return {
    event: eventName,
    data: JSON.parse(rawData) as unknown,
  };
}

/**
 * Yields one SSE event at a time.
 *
 * The buffer matters: a provider can split a line, an event or a multi-byte
 * character across two network chunks. TextDecoder with `stream: true` covers
 * the character case; the explicit buffer covers the others.
 */
export async function* readEventStream(body: ReadableStream<Uint8Array>): AsyncIterable<RawEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finished = false;

  try {
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (err) {
        throw toProviderError(err, "stream read failed");
      }
      const { value, done } = chunk;
      if (done) {
        finished = true;
        buffer = (buffer + decoder.decode()).replace(/\r\n/g, "\n");
        break;
      }
      buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, "\n");
      for (let at = buffer.indexOf("\n\n"); at !== -1; at = buffer.indexOf("\n\n")) {
        const block = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        const parsed = parseBlock(block);
        if (parsed === "done") {
          return;
        }
        if (parsed !== null) {
          yield parsed;
        }
      }
    }

    if (buffer.trim().length > 0) {
      const parsed = parseBlock(buffer);
      if (parsed !== null && parsed !== "done") {
        yield parsed;
      }
    }
  } finally {
    if (!finished) {
      await reader.cancel().catch(() => {});
    }
    reader.releaseLock();
  }
}
