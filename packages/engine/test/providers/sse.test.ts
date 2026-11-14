import { describe, expect, it } from "vitest";
import { readEventStream } from "../../src/providers/sse.js";

function streamFromChunks(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

describe("readEventStream", () => {
  it("reassembles payloads split mid-line, mid-event, and mid-UTF-8 character", async () => {
    const encoder = new TextEncoder();
    const payload =
      'event: delta\ndata: {"text":"Hello 🌍"}\n\n' + 'event: delta\ndata: {"text":"!"}\n\n';
    const bytes = encoder.encode(payload);

    // Find the 4-byte UTF-8 sequence for 🌍 (starts with 0xF0) and split right inside it.
    const emojiStart = bytes.indexOf(0xf0);
    expect(emojiStart).toBeGreaterThan(0);

    const chunk1 = bytes.slice(0, 10); // mid-line ("event: del")
    const chunk2 = bytes.slice(10, emojiStart + 2); // mid-UTF-8 character
    const chunk3 = bytes.slice(emojiStart + 2, emojiStart + 10); // mid-event
    const chunk4 = bytes.slice(emojiStart + 10);

    const events = [];
    for await (const event of readEventStream(streamFromChunks([chunk1, chunk2, chunk3, chunk4]))) {
      events.push(event);
    }

    expect(events).toEqual([
      { event: "delta", data: { text: "Hello 🌍" } },
      { event: "delta", data: { text: "!" } },
    ]);
  });

  it("yields nothing for blank-line-only and comment-only chunks", async () => {
    const encoder = new TextEncoder();
    const chunks = [
      encoder.encode("\n\n\n\n"),
      encoder.encode(": keepalive\n\n"),
      encoder.encode('data: {"ok":true}\n\n'),
      encoder.encode("\r\n\r\n"),
    ];

    const events = [];
    for await (const event of readEventStream(streamFromChunks(chunks))) {
      events.push(event);
    }

    expect(events).toEqual([{ event: undefined, data: { ok: true } }]);
  });

  it("stops at the [DONE] sentinel", async () => {
    const encoder = new TextEncoder();
    const chunks = [encoder.encode('data: {"n":1}\n\ndata: [DONE]\n\ndata: {"n":2}\n\n')];

    const events = [];
    for await (const event of readEventStream(streamFromChunks(chunks))) {
      events.push(event);
    }

    expect(events).toEqual([{ event: undefined, data: { n: 1 } }]);
  });
});
