export interface RawEventLine {
  name: string;
  data: string;
}

function parseBlock(block: string): RawEventLine | null {
  let name = "message";
  const dataLines: string[] = [];

  for (const line of block.split("\n")) {
    if (line === "" || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") {
      name = value;
    } else if (field === "data") {
      dataLines.push(value);
    }
  }

  if (dataLines.length === 0) return null;
  return { name, data: dataLines.join("\n") };
}

/**
 * Reads an SSE response body and yields raw `{ name, data }` pairs.
 * Buffers partial lines across network chunks.
 */
export async function* readEventLines(response: Response): AsyncIterable<RawEventLine> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finished = false;

  try {
    for (;;) {
      const { value, done } = await reader.read();
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
        if (parsed !== null) yield parsed;
      }
    }

    if (buffer.trim().length > 0) {
      const parsed = parseBlock(buffer);
      if (parsed !== null) yield parsed;
    }
  } finally {
    if (!finished) {
      await reader.cancel().catch(() => {});
    }
    reader.releaseLock();
  }
}
