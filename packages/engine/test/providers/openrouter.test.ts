import { describe, expect, it, vi } from "vitest";
import { ProviderError } from "../../src/providers/error.js";
import { openrouterProvider } from "../../src/providers/openrouter.js";
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

describe("openrouterProvider", () => {
  it("streams text, reports usage and cost in micros, sends attribution headers, and passes model unchanged", async () => {
    const fakeKey = "sk-or-v1-test-secret-do-not-leak";
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;

    const provider = openrouterProvider({
      apiKey: fakeKey,
      model: "anthropic/claude-sonnet-4",
      fetchImpl: async (input, init) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        capturedInit = init;
        return sseResponse(
          [
            'data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}\n\n',
            'data: {"choices":[{"delta":{"content":" world"},"finish_reason":null}]}\n\n',
            'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
            'data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":5,"cost":0.00123}}\n\n',
            "data: [DONE]\n\n",
          ].join(""),
        );
      },
    });

    const chunks = await collect(provider.stream(SAMPLE_REQUEST));

    expect(chunks).toEqual([
      { kind: "text", text: "Hello" },
      { kind: "text", text: " world" },
      { kind: "usage", tokensIn: 11, tokensOut: 5, costMicros: 1230 },
    ]);

    expect(capturedUrl).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(capturedUrl).not.toContain(fakeKey);
    const headers = new Headers(capturedInit?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${fakeKey}`);
    expect(headers.get("http-referer")).toBe("https://solv.chat");
    expect(headers.get("x-title")).toBe("solv.chat");

    const body = JSON.parse(String(capturedInit?.body)) as Record<string, unknown>;
    expect(body.stream).toBe(true);
    expect(body.model).toBe("anthropic/claude-sonnet-4");
    expect(body.max_tokens).toBe(256);
    expect(body.stream_options).toBeUndefined();
  });

  it("distinguishes known zero cost from omitted cost", async () => {
    const freeModel = openrouterProvider({
      apiKey: "test-key",
      model: "meta-llama/llama-3.3-70b-instruct:free",
      fetchImpl: async () =>
        sseResponse(
          [
            'data: {"choices":[{"delta":{"content":"Free"},"finish_reason":"stop"}]}\n\n',
            'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2,"cost":0}}\n\n',
            "data: [DONE]\n\n",
          ].join(""),
        ),
    });

    expect(await collect(freeModel.stream(SAMPLE_REQUEST))).toEqual([
      { kind: "text", text: "Free" },
      { kind: "usage", tokensIn: 10, tokensOut: 2, costMicros: 0 },
    ]);

    const noCostReported = openrouterProvider({
      apiKey: "test-key",
      model: "vendor/unknown-cost-model",
      fetchImpl: async () =>
        sseResponse(
          [
            'data: {"choices":[{"delta":{"content":"Hi"},"finish_reason":"stop"}]}\n\n',
            'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2}}\n\n',
            "data: [DONE]\n\n",
          ].join(""),
        ),
    });

    expect(await collect(noCostReported.stream(SAMPLE_REQUEST))).toEqual([
      { kind: "text", text: "Hi" },
      { kind: "usage", tokensIn: 10, tokensOut: 2 },
    ]);
  });

  it("throws ProviderError on mid-stream error event without leaking key", async () => {
    const secret = "sk-or-v1-stream-secret";
    const provider = openrouterProvider({
      apiKey: secret,
      model: "vendor/model",
      fetchImpl: async () =>
        sseResponse(
          [
            'data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n',
            `data: {"error":{"code":429,"message":"Rate limit exceeded for ${secret}"},"choices":[{"index":0,"delta":{"content":""},"finish_reason":"error"}]}\n\n`,
          ].join(""),
        ),
    });

    let caught: unknown;
    try {
      await collect(provider.stream(SAMPLE_REQUEST));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ProviderError);
    expect((caught as ProviderError).retryable).toBe(true);
    expect((caught as ProviderError).message).not.toContain(secret);
  });

  it("maps HTTP errors and fetch rejections to sanitized ProviderError without leaking key", async () => {
    const secret = "sk-or-v1-very-secret-key";

    const p429 = openrouterProvider({
      apiKey: secret,
      model: "vendor/model",
      fetchImpl: async () => new Response("rate limited", { status: 429 }),
    });
    await expect(collect(p429.stream(SAMPLE_REQUEST))).rejects.toMatchObject({
      name: "ProviderError",
      retryable: true,
      status: 429,
    });

    const p401 = openrouterProvider({
      apiKey: secret,
      model: "vendor/model",
      fetchImpl: async () => new Response(`invalid key: ${secret}`, { status: 401 }),
    });
    let caught401: unknown;
    try {
      await collect(p401.stream(SAMPLE_REQUEST));
    } catch (err) {
      caught401 = err;
    }
    expect(caught401).toBeInstanceOf(ProviderError);
    expect((caught401 as ProviderError).retryable).toBe(false);
    expect((caught401 as ProviderError).status).toBe(401);
    expect((caught401 as ProviderError).message).not.toContain(secret);

    const rejecting = openrouterProvider({
      apiKey: secret,
      model: "vendor/model",
      fetchImpl: async () => {
        throw new TypeError(`connection reset for ${secret}`);
      },
    });
    let caughtFetch: unknown;
    try {
      await collect(rejecting.stream(SAMPLE_REQUEST));
    } catch (err) {
      caughtFetch = err;
    }
    expect(caughtFetch).toBeInstanceOf(ProviderError);
    expect((caughtFetch as ProviderError).retryable).toBe(true);
    expect((caughtFetch as ProviderError).message).not.toContain(secret);
  });

  it("throws when stream ends early or without usage, and cancels on break", async () => {
    const noFinish = openrouterProvider({
      apiKey: "test-key",
      model: "vendor/model",
      fetchImpl: async () =>
        sseResponse('data: {"choices":[{"delta":{"content":"half"},"finish_reason":null}]}\n\n'),
    });
    await expect(collect(noFinish.stream(SAMPLE_REQUEST))).rejects.toBeInstanceOf(ProviderError);

    const noUsage = openrouterProvider({
      apiKey: "test-key",
      model: "vendor/model",
      fetchImpl: async () =>
        sseResponse('data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\n'),
    });
    await expect(collect(noUsage.stream(SAMPLE_REQUEST))).rejects.toBeInstanceOf(ProviderError);

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
    const cancellable = openrouterProvider({
      apiKey: "test-key",
      model: "vendor/model",
      fetchImpl: async () =>
        new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }),
    });
    const received: LlmChunk[] = [];
    for await (const chunk of cancellable.stream(SAMPLE_REQUEST)) {
      received.push(chunk);
      break;
    }
    expect(received).toEqual([{ kind: "text", text: "Hello" }]);
    expect(cancelSpy).toHaveBeenCalledTimes(1);
  });
});
