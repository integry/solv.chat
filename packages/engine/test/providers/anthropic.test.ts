import { describe, expect, it } from "vitest";
import { anthropicProvider } from "../../src/providers/anthropic.js";
import { ProviderError } from "../../src/providers/error.js";
import type { LlmChunk, LlmRequest } from "../../src/providers/types.js";

const SAMPLE_REQUEST: LlmRequest = {
  system: "You are helpful.",
  messages: [{ role: "user", content: "Hi" }],
  maxTokens: 256,
};

function sseResponse(bodyText: string, status = 200): Response {
  const bytes = new TextEncoder().encode(bodyText);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.slice(0, Math.floor(bytes.length / 2)));
      controller.enqueue(bytes.slice(Math.floor(bytes.length / 2)));
      controller.close();
    },
  });
  return new Response(stream, {
    status,
    headers: { "content-type": "text/event-stream" },
  });
}

async function collect(iter: AsyncIterable<LlmChunk>): Promise<LlmChunk[]> {
  const out: LlmChunk[] = [];
  for await (const chunk of iter) {
    out.push(chunk);
  }
  return out;
}

describe("anthropicProvider", () => {
  it("streams text chunks in order, emits final usage, and sends key only in header", async () => {
    const fakeKey = "sk-ant-test-secret-do-not-leak";
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;

    const provider = anthropicProvider({
      apiKey: fakeKey,
      model: "claude-haiku-5-5",
      fetchImpl: async (input, init) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        capturedInit = init;
        return sseResponse(
          [
            'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":14}}}\n\n',
            'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}\n\n',
            'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":" world"}}\n\n',
            'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":7}}\n\n',
            'event: message_stop\ndata: {"type":"message_stop"}\n\n',
          ].join(""),
        );
      },
    });

    const chunks = await collect(provider.stream(SAMPLE_REQUEST));

    expect(chunks).toEqual([
      { kind: "text", text: "Hello" },
      { kind: "text", text: " world" },
      { kind: "usage", tokensIn: 14, tokensOut: 7 },
    ]);

    expect(capturedUrl).not.toContain(fakeKey);
    const headers = new Headers(capturedInit?.headers);
    expect(headers.get("x-api-key")).toBe(fakeKey);
    expect(headers.get("anthropic-version")).toBeTruthy();

    const body = JSON.parse(String(capturedInit?.body)) as Record<string, unknown>;
    expect(body.stream).toBe(true);
    expect(body.model).toBe("claude-haiku-5-5");
  });

  it("throws ProviderError on mid-stream error event", async () => {
    const provider = anthropicProvider({
      apiKey: "test-key",
      model: "claude-haiku-5-5",
      fetchImpl: async () =>
        sseResponse(
          [
            'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"partial"}}\n\n',
            'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n',
          ].join(""),
        ),
    });

    await expect(collect(provider.stream(SAMPLE_REQUEST))).rejects.toMatchObject({
      name: "ProviderError",
      retryable: true,
    });
  });

  it("maps 429 to retryable: true, 400 to retryable: false, and 401 without key material", async () => {
    const secret = "sk-ant-very-secret-key-12345";

    const p429 = anthropicProvider({
      apiKey: secret,
      model: "claude-haiku-5-5",
      fetchImpl: async () => new Response("rate limited", { status: 429 }),
    });
    await expect(collect(p429.stream(SAMPLE_REQUEST))).rejects.toMatchObject({
      name: "ProviderError",
      retryable: true,
      status: 429,
    });

    const p400 = anthropicProvider({
      apiKey: secret,
      model: "claude-haiku-5-5",
      fetchImpl: async () => new Response("bad request", { status: 400 }),
    });
    await expect(collect(p400.stream(SAMPLE_REQUEST))).rejects.toMatchObject({
      name: "ProviderError",
      retryable: false,
      status: 400,
    });

    const p401 = anthropicProvider({
      apiKey: secret,
      model: "claude-haiku-5-5",
      fetchImpl: async () => new Response(`invalid key: ${secret}`, { status: 401 }),
    });
    let caught: unknown;
    try {
      await collect(p401.stream(SAMPLE_REQUEST));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ProviderError);
    expect((caught as ProviderError).retryable).toBe(false);
    expect((caught as ProviderError).status).toBe(401);
    expect((caught as ProviderError).message).not.toContain(secret);
  });

  it("throws when stream ends without message_stop", async () => {
    const provider = anthropicProvider({
      apiKey: "test-key",
      model: "claude-haiku-5-5",
      fetchImpl: async () =>
        sseResponse(
          'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"half"}}\n\n',
        ),
    });

    await expect(collect(provider.stream(SAMPLE_REQUEST))).rejects.toBeInstanceOf(ProviderError);
  });
});
