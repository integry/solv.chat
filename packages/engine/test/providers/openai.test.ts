import { describe, expect, it, vi } from "vitest";
import { ProviderError } from "../../src/providers/error.js";
import { openaiProvider } from "../../src/providers/openai.js";
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

describe("openaiProvider", () => {
  it("streams text chunks in order, emits final usage, and sends key only in header", async () => {
    const fakeKey = "sk-openai-test-secret-do-not-leak";
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;

    const provider = openaiProvider({
      apiKey: fakeKey,
      model: "gpt-5-mini",
      fetchImpl: async (input, init) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        capturedInit = init;
        return sseResponse(
          [
            'data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}\n\n',
            'data: {"choices":[{"delta":{"content":" world"},"finish_reason":null}]}\n\n',
            'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
            'data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":5}}\n\n',
            "data: [DONE]\n\n",
          ].join(""),
        );
      },
    });

    const chunks = await collect(provider.stream(SAMPLE_REQUEST));

    expect(chunks).toEqual([
      { kind: "text", text: "Hello" },
      { kind: "text", text: " world" },
      { kind: "usage", tokensIn: 11, tokensOut: 5 },
    ]);

    expect(capturedUrl).not.toContain(fakeKey);
    const headers = new Headers(capturedInit?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${fakeKey}`);

    const body = JSON.parse(String(capturedInit?.body)) as Record<string, unknown>;
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.model).toBe("gpt-5-mini");
  });

  it("throws ProviderError on mid-stream error event", async () => {
    const provider = openaiProvider({
      apiKey: "test-key",
      model: "gpt-5-mini",
      fetchImpl: async () =>
        sseResponse(
          [
            'data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n',
            'data: {"error":{"type":"server_error","message":"boom"}}\n\n',
          ].join(""),
        ),
    });

    await expect(collect(provider.stream(SAMPLE_REQUEST))).rejects.toMatchObject({
      name: "ProviderError",
      retryable: true,
    });
  });

  it("maps 429 to retryable: true, 400 to retryable: false, and 401 without key material", async () => {
    const secret = "sk-openai-very-secret-key-12345";

    const p429 = openaiProvider({
      apiKey: secret,
      model: "gpt-5-mini",
      fetchImpl: async () => new Response("rate limited", { status: 429 }),
    });
    await expect(collect(p429.stream(SAMPLE_REQUEST))).rejects.toMatchObject({
      name: "ProviderError",
      retryable: true,
      status: 429,
    });

    const p400 = openaiProvider({
      apiKey: secret,
      model: "gpt-5-mini",
      fetchImpl: async () => new Response("bad request", { status: 400 }),
    });
    await expect(collect(p400.stream(SAMPLE_REQUEST))).rejects.toMatchObject({
      name: "ProviderError",
      retryable: false,
      status: 400,
    });

    const p401 = openaiProvider({
      apiKey: secret,
      model: "gpt-5-mini",
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

  it("throws when stream ends without finish_reason", async () => {
    const provider = openaiProvider({
      apiKey: "test-key",
      model: "gpt-5-mini",
      fetchImpl: async () =>
        sseResponse('data: {"choices":[{"delta":{"content":"half"},"finish_reason":null}]}\n\n'),
    });

    await expect(collect(provider.stream(SAMPLE_REQUEST))).rejects.toBeInstanceOf(ProviderError);
  });

  it("cancels the underlying stream when the consumer breaks early", async () => {
    const cancelSpy = vi.fn();
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            'data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}\n\n',
          ),
        );
      },
      cancel: cancelSpy,
    });

    const provider = openaiProvider({
      apiKey: "test-key",
      model: "gpt-5-mini",
      fetchImpl: async () =>
        new Response(stream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    });

    const received: LlmChunk[] = [];
    for await (const chunk of provider.stream(SAMPLE_REQUEST)) {
      received.push(chunk);
      break;
    }

    expect(received).toEqual([{ kind: "text", text: "Hello" }]);
    expect(cancelSpy).toHaveBeenCalledTimes(1);
  });

  it("throws ProviderError on EOF after finish_reason but before usage", async () => {
    const provider = openaiProvider({
      apiKey: "test-key",
      model: "gpt-5-mini",
      fetchImpl: async () =>
        sseResponse(
          [
            'data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}\n\n',
            'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
          ].join(""),
        ),
    });

    await expect(collect(provider.stream(SAMPLE_REQUEST))).rejects.toMatchObject({
      name: "ProviderError",
      retryable: true,
    });
  });

  it("normalizes rejected fetch into a sanitized retryable ProviderError and preserves ProviderError", async () => {
    const secret = "sk-openai-fetch-secret";
    const rejecting = openaiProvider({
      apiKey: secret,
      model: "gpt-5-mini",
      fetchImpl: async () => {
        throw new TypeError(`connection reset for ${secret}`);
      },
    });

    let caught: unknown;
    try {
      await collect(rejecting.stream(SAMPLE_REQUEST));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ProviderError);
    expect((caught as ProviderError).retryable).toBe(true);
    expect((caught as ProviderError).message).not.toContain(secret);

    const existing = new ProviderError("custom non-retryable", false, 403);
    const preserving = openaiProvider({
      apiKey: secret,
      model: "gpt-5-mini",
      fetchImpl: async () => {
        throw existing;
      },
    });
    await expect(collect(preserving.stream(SAMPLE_REQUEST))).rejects.toBe(existing);
  });

  it("normalizes rejected stream reads into a retryable ProviderError", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            'data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n',
          ),
        );
      },
      pull() {
        return Promise.reject(new Error("stream connection dropped"));
      },
    });

    const provider = openaiProvider({
      apiKey: "test-key",
      model: "gpt-5-mini",
      fetchImpl: async () =>
        new Response(stream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    });

    await expect(collect(provider.stream(SAMPLE_REQUEST))).rejects.toMatchObject({
      name: "ProviderError",
      retryable: true,
    });
  });
});
