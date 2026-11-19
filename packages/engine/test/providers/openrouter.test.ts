import { describe, expect, it, vi } from "vitest";
import { EmptyReplyError, ProviderError } from "../../src/providers/error.js";
import { openrouterProvider } from "../../src/providers/openrouter.js";
import { REASONING_FALLBACK_MIN_OUTPUT_TOKENS } from "../../src/providers/reasoning.js";
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

  it("sanitizes string error.code values so secrets cannot leak", async () => {
    const secret = "sk-or-v1-code-secret";
    const provider = openrouterProvider({
      apiKey: secret,
      model: "vendor/model",
      fetchImpl: async () =>
        sseResponse(
          `data: {"error":{"code":"upstream_error_${secret}","message":"bad"},"choices":[{"index":0,"delta":{"content":""},"finish_reason":"error"}]}\n\n`,
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
    expect((caught as ProviderError).message).toBe("openrouter stream error");
    expect((caught as ProviderError).message).not.toContain(secret);

    const nonRetryable = openrouterProvider({
      apiKey: secret,
      model: "vendor/model",
      fetchImpl: async () =>
        sseResponse(
          'data: {"error":{"code":"invalid_request_error","message":"bad"},"choices":[{"index":0,"delta":{"content":""},"finish_reason":"error"}]}\n\n',
        ),
    });
    await expect(collect(nonRetryable.stream(SAMPLE_REQUEST))).rejects.toMatchObject({
      name: "ProviderError",
      retryable: false,
      message: "openrouter stream error",
    });
  });

  it("emits usage attached to a mid-stream error event before throwing", async () => {
    const provider = openrouterProvider({
      apiKey: "test-key",
      model: "vendor/model",
      fetchImpl: async () =>
        sseResponse(
          [
            'data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n',
            'data: {"error":{"code":502,"message":"upstream failed"},"usage":{"prompt_tokens":14,"completion_tokens":3,"cost":0.0025},"choices":[{"index":0,"delta":{"content":""},"finish_reason":"error"}]}\n\n',
          ].join(""),
        ),
    });

    const yielded: LlmChunk[] = [];
    let caught: unknown;
    try {
      for await (const chunk of provider.stream(SAMPLE_REQUEST)) {
        yielded.push(chunk);
      }
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ProviderError);
    expect((caught as ProviderError).retryable).toBe(true);
    expect(yielded).toEqual([
      { kind: "text", text: "partial" },
      { kind: "usage", tokensIn: 14, tokensOut: 3, costMicros: 2500 },
    ]);
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

  describe("reasoning off", () => {
    const OFF: LlmRequest = { ...SAMPLE_REQUEST, maxTokens: 64, reasoning: "off" };
    const TEXT_STREAM = [
      'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":11,"completion_tokens":2}}\n\n',
      "data: [DONE]\n\n",
    ].join("");
    const REASONING_ONLY_STREAM = [
      'data: {"choices":[{"delta":{"reasoning_details":[{"type":"reasoning.text","text":"Hmm"}]},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"length"}],"usage":{"prompt_tokens":11,"completion_tokens":64,"completion_tokens_details":{"reasoning_tokens":64}}}\n\n',
      "data: [DONE]\n\n",
    ].join("");

    function recording(responses: Array<() => Response>) {
      const bodies: Record<string, unknown>[] = [];
      const fetchImpl: typeof fetch = async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        const next = responses[Math.min(bodies.length - 1, responses.length - 1)];
        if (!next) throw new Error("no response scripted");
        return next();
      };
      return { bodies, fetchImpl };
    }

    it("sends no reasoning field when the request does not ask", async () => {
      const { bodies, fetchImpl } = recording([() => sseResponse(TEXT_STREAM)]);
      const provider = openrouterProvider({ apiKey: "k", model: "some/model", fetchImpl });
      await collect(provider.stream(SAMPLE_REQUEST));
      expect(bodies[0]).not.toHaveProperty("reasoning");
    });

    it("asks for reasoning effort none, keeping the small limit", async () => {
      const { bodies, fetchImpl } = recording([() => sseResponse(TEXT_STREAM)]);
      const provider = openrouterProvider({ apiKey: "k", model: "some/model", fetchImpl });
      await collect(provider.stream(OFF));
      expect(bodies[0]).toMatchObject({ reasoning: { effort: "none" }, max_tokens: 64 });
    });

    it("asks again without it, with room to reason, when reasoning is mandatory", async () => {
      const { bodies, fetchImpl } = recording([
        () => new Response('{"error":{"message":"PROVIDER_TEXT"}}', { status: 400 }),
        () => sseResponse(TEXT_STREAM),
      ]);
      const provider = openrouterProvider({ apiKey: "k", model: "some/reasoner", fetchImpl });
      const chunks = await collect(provider.stream(OFF));
      expect(chunks[0]).toEqual({ kind: "text", text: "ok" });
      expect(bodies).toHaveLength(2);
      expect(bodies[1]).not.toHaveProperty("reasoning");
      expect(bodies[1]?.max_tokens).toBe(REASONING_FALLBACK_MIN_OUTPUT_TOKENS);
    });

    it("reports a reasoning-only reply as EmptyReplyError, after its usage", async () => {
      const { fetchImpl } = recording([() => sseResponse(REASONING_ONLY_STREAM)]);
      const provider = openrouterProvider({ apiKey: "k", model: "some/model", fetchImpl });
      const chunks: LlmChunk[] = [];
      let error: unknown;
      try {
        for await (const chunk of provider.stream(SAMPLE_REQUEST)) chunks.push(chunk);
      } catch (err) {
        error = err;
      }
      expect(chunks).toEqual([{ kind: "usage", tokensIn: 11, tokensOut: 64 }]);
      expect(error).toBeInstanceOf(EmptyReplyError);
    });
  });
});
