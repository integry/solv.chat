/** One server-sent event: its `event:` name (if any) and joined `data:` lines. */
export interface SseBlock {
  event: string | undefined;
  data: string;
}

/**
 * Parses one blank-line-delimited SSE block. Comment lines and blocks with no
 * `data:` line yield null; unknown fields are ignored, as the format requires.
 */
export function parseSseBlock(block: string): SseBlock | null {
  let event: string | undefined;
  const dataLines: string[] = [];

  for (const line of block.split("\n")) {
    if (line === "" || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") {
      event = value;
    } else if (field === "data") {
      dataLines.push(value);
    }
  }

  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join("\n") };
}

export interface ReadSseOptions {
  /** Stops reading and cancels the body when aborted. */
  signal?: AbortSignal | undefined;
  /** Maps a failed network read into the caller's own error type. */
  mapReadError?: ((err: unknown) => unknown) | undefined;
}

/**
 * Yields one SSE block at a time from a response body.
 *
 * The buffer matters: a server can split a line, an event or a multi-byte
 * character across two network chunks. TextDecoder with `stream: true` covers
 * the character case; the explicit buffer covers the others. Stopping early
 * (a `break`, a `return`, an abort) cancels the body so the connection closes.
 */
export async function* readSseBlocks(
  body: ReadableStream<Uint8Array>,
  options: ReadSseOptions = {},
): AsyncGenerator<SseBlock, void, undefined> {
  const { signal, mapReadError } = options;
  if (signal?.aborted) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finished = false;
  const onAbort = () => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    for (;;) {
      if (signal?.aborted) return;
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (err) {
        throw mapReadError ? mapReadError(err) : err;
      }
      if (signal?.aborted) return;
      if (chunk.done) {
        finished = true;
        buffer = (buffer + decoder.decode()).replace(/\r\n/g, "\n");
        break;
      }
      buffer = (buffer + decoder.decode(chunk.value, { stream: true })).replace(/\r\n/g, "\n");
      for (let at = buffer.indexOf("\n\n"); at !== -1; at = buffer.indexOf("\n\n")) {
        if (signal?.aborted) return;
        const block = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        const parsed = parseSseBlock(block);
        if (parsed !== null) yield parsed;
      }
    }

    if (!signal?.aborted && buffer.trim().length > 0) {
      const parsed = parseSseBlock(buffer);
      if (parsed !== null) yield parsed;
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    if (!finished) {
      await reader.cancel().catch(() => {});
    }
    reader.releaseLock();
  }
}
