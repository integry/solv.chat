import { readSseBlocks } from "@solvchat/core";

export interface RawEventLine {
  name: string;
  data: string;
}

/**
 * Reads an SSE response body and yields raw `{ name, data }` pairs, using the
 * one SSE reader in `@solvchat/core` so the widget, admin and engine cannot
 * disagree about the format. A block with no `event:` line is a `message`.
 */
export async function* readEventLines(response: Response): AsyncIterable<RawEventLine> {
  if (!response.body) return;
  for await (const block of readSseBlocks(response.body)) {
    yield { name: block.event ?? "message", data: block.data };
  }
}
