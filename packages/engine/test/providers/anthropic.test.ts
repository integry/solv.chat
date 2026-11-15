import { describe, expect, it, vi } from "vitest";
import { anthropicProvider } from "../../src/providers/anthropic.js";
import { ProviderError } from "../../src/providers/error.js";
import type { LlmChunk, LlmRequest, ToolDefinition } from "../../src/providers/types.js";

const SAMPLE_REQUEST: LlmRequest = {
  system: "You are helpful.",
  messages: [{ role: "user", content: "Hi" }],
  maxTokens: 256,
};

const SAMPLE_TOOL: ToolDefinition = {
  name: "lookup_order",
  description: "Look up an order by id.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
  },
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

/** Collects chunks until the stream throws, keeping both. */
async function collectUntilThrow(
  iter: AsyncIterable<LlmChunk>,
): Promise<{ chunks: LlmChunk[]; error: unknown }> {
  const chunks: LlmChunk[] = [];
  try {
    for await (const chunk of iter) chunks.push(chunk);
  } catch (error) {
    return { chunks, error };
  }
  return { chunks, error: undefined };
}

/** A response that delivers `events`, then fails the next read. */
function failingAfter(events: string[]): Response {
  const encoder = new TextEncoder();
  let sent = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(encoder.encode(events.join("")));
        return;
      }
      return Promise.reject(new Error("stream connection dropped"));
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
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

  it("cancels the underlying stream when the consumer breaks early", async () => {
    const cancelSpy = vi.fn();
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}\n\n',
          ),
        );
      },
      cancel: cancelSpy,
    });

    const provider = anthropicProvider({
      apiKey: "test-key",
      model: "claude-haiku-5-5",
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

  it("throws ProviderError when message_stop arrives without complete usage", async () => {
    const provider = anthropicProvider({
      apiKey: "test-key",
      model: "claude-haiku-5-5",
      fetchImpl: async () =>
        sseResponse(
          [
            'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}\n\n',
            'event: message_stop\ndata: {"type":"message_stop"}\n\n',
          ].join(""),
        ),
    });

    await expect(collect(provider.stream(SAMPLE_REQUEST))).rejects.toMatchObject({
      name: "ProviderError",
      retryable: true,
    });
  });

  it("normalizes rejected fetch into a sanitized retryable ProviderError and preserves ProviderError", async () => {
    const secret = "sk-ant-fetch-secret";
    const rejecting = anthropicProvider({
      apiKey: secret,
      model: "claude-haiku-5-5",
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
    const preserving = anthropicProvider({
      apiKey: secret,
      model: "claude-haiku-5-5",
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
            'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"partial"}}\n\n',
          ),
        );
      },
      pull() {
        return Promise.reject(new Error("stream connection dropped"));
      },
    });

    const provider = anthropicProvider({
      apiKey: "test-key",
      model: "claude-haiku-5-5",
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
  describe("usage already reported when the stream then fails", () => {
    const START =
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":14}}}\n\n';
    const TEXT =
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}\n\n';
    const DELTA =
      'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":7}}\n\n';

    const cases: Array<[string, () => Response, { tokensIn: number; tokensOut: number }]> = [
      [
        "ends before message_stop",
        () => sseResponse([START, TEXT, DELTA].join("")),
        { tokensIn: 14, tokensOut: 7 },
      ],
      [
        "read fails after message_delta",
        () => failingAfter([START, TEXT, DELTA]),
        { tokensIn: 14, tokensOut: 7 },
      ],
      [
        "read fails before message_delta",
        () => failingAfter([START, TEXT]),
        { tokensIn: 14, tokensOut: 0 },
      ],
      [
        "error event after message_delta",
        () =>
          sseResponse(
            [
              START,
              DELTA,
              'event: error\ndata: {"type":"error","error":{"type":"overloaded_error"}}\n\n',
            ].join(""),
          ),
        { tokensIn: 14, tokensOut: 7 },
      ],
    ];

    it.each(cases)("%s: yields one usage chunk, then throws", async (_name, respond, usage) => {
      const provider = anthropicProvider({
        apiKey: "test-key",
        model: "claude-haiku-5-5",
        fetchImpl: async () => respond(),
      });
      const { chunks, error } = await collectUntilThrow(provider.stream(SAMPLE_REQUEST));
      expect(error).toBeInstanceOf(ProviderError);
      expect(chunks.filter((c) => c.kind === "usage")).toEqual([{ kind: "usage", ...usage }]);
    });

    it("yields no usage chunk when nothing was reported", async () => {
      const provider = anthropicProvider({
        apiKey: "test-key",
        model: "claude-haiku-5-5",
        fetchImpl: async () => failingAfter([TEXT]),
      });
      const { chunks, error } = await collectUntilThrow(provider.stream(SAMPLE_REQUEST));
      expect(error).toBeInstanceOf(ProviderError);
      expect(chunks).toEqual([{ kind: "text", text: "Hi" }]);
    });
  });

  describe("tool calling", () => {
    it("omits the tools field entirely when no tool is allowed", async () => {
      let body: Record<string, unknown> = {};
      const provider = anthropicProvider({
        apiKey: "test-key",
        model: "claude-haiku-5-5",
        fetchImpl: async (_input, init) => {
          body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return sseResponse(
            [
              'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10}}}\n\n',
              'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Ok"}}\n\n',
              'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":2}}\n\n',
              'event: message_stop\ndata: {"type":"message_stop"}\n\n',
            ].join(""),
          );
        },
      });
      await collect(provider.stream(SAMPLE_REQUEST));
      expect("tools" in body).toBe(false);
    });

    it("serializes tool definitions and tool-exchange messages in the request body", async () => {
      let body: Record<string, unknown> = {};
      const provider = anthropicProvider({
        apiKey: "test-key",
        model: "claude-haiku-5-5",
        fetchImpl: async (_input, init) => {
          body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return sseResponse(
            [
              'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":20}}}\n\n',
              'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Done"}}\n\n',
              'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}\n\n',
              'event: message_stop\ndata: {"type":"message_stop"}\n\n',
            ].join(""),
          );
        },
      });

      const chunks = await collect(
        provider.stream({
          system: "You are helpful.",
          maxTokens: 256,
          tools: [SAMPLE_TOOL],
          messages: [
            { role: "user", content: "Check order A-1" },
            {
              role: "assistant",
              content: "Checking.",
              toolCalls: [{ callId: "toolu_1", name: "lookup_order", input: { id: "A-1" } }],
            },
            {
              role: "tool_results",
              results: [{ callId: "toolu_1", content: "shipped", isError: false }],
            },
          ],
        }),
      );

      expect(body.tools).toEqual([
        {
          name: "lookup_order",
          description: "Look up an order by id.",
          input_schema: SAMPLE_TOOL.inputSchema,
        },
      ]);
      expect(body.messages).toEqual([
        { role: "user", content: "Check order A-1" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Checking." },
            { type: "tool_use", id: "toolu_1", name: "lookup_order", input: { id: "A-1" } },
          ],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "shipped" }],
        },
      ]);
      expect(chunks).toEqual([
        { kind: "text", text: "Done" },
        { kind: "usage", tokensIn: 20, tokensOut: 3, stopReason: "end" },
      ]);
    });

    it("reassembles a tool call split across input_json_delta fragments and surfaces tools stopReason", async () => {
      const provider = anthropicProvider({
        apiKey: "test-key",
        model: "claude-haiku-5-5",
        fetchImpl: async () =>
          sseResponse(
            [
              'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":12}}}\n\n',
              'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"lookup_order"}}\n\n',
              'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"id\\":"}}\n\n',
              'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"A-1\\"}"}}\n\n',
              'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
              'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":4}}\n\n',
              'event: message_stop\ndata: {"type":"message_stop"}\n\n',
            ].join(""),
          ),
      });

      const chunks = await collect(provider.stream({ ...SAMPLE_REQUEST, tools: [SAMPLE_TOOL] }));
      expect(chunks).toEqual([
        {
          kind: "tool_call",
          call: { callId: "toolu_1", name: "lookup_order", input: { id: "A-1" } },
        },
        { kind: "usage", tokensIn: 12, tokensOut: 4, stopReason: "tools" },
      ]);
    });

    it("yields text and tool_call chunks in arrival order", async () => {
      const provider = anthropicProvider({
        apiKey: "test-key",
        model: "claude-haiku-5-5",
        fetchImpl: async () =>
          sseResponse(
            [
              'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":15}}}\n\n',
              'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Checking "}}\n\n',
              'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_2","name":"lookup_order"}}\n\n',
              'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"id\\":\\"B-2\\"}"}}\n\n',
              'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
              'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":6}}\n\n',
              'event: message_stop\ndata: {"type":"message_stop"}\n\n',
            ].join(""),
          ),
      });

      const chunks = await collect(provider.stream({ ...SAMPLE_REQUEST, tools: [SAMPLE_TOOL] }));
      expect(chunks).toEqual([
        { kind: "text", text: "Checking " },
        {
          kind: "tool_call",
          call: { callId: "toolu_2", name: "lookup_order", input: { id: "B-2" } },
        },
        { kind: "usage", tokensIn: 15, tokensOut: 6, stopReason: "tools" },
      ]);
    });

    it("turns malformed tool input JSON into a non-retryable ProviderError", async () => {
      const provider = anthropicProvider({
        apiKey: "test-key",
        model: "claude-haiku-5-5",
        fetchImpl: async () =>
          sseResponse(
            [
              'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10}}}\n\n',
              'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_bad","name":"lookup_order"}}\n\n',
              'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{not-json"}}\n\n',
              'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
            ].join(""),
          ),
      });

      const { chunks, error } = await collectUntilThrow(
        provider.stream({ ...SAMPLE_REQUEST, tools: [SAMPLE_TOOL] }),
      );
      expect(error).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).retryable).toBe(false);
      expect(chunks).toEqual([{ kind: "usage", tokensIn: 10, tokensOut: 0 }]);
    });

    it("suppresses truncated tool calls and preserves usage and length stopReason on max_tokens", async () => {
      const provider = anthropicProvider({
        apiKey: "test-key",
        model: "claude-haiku-5-5",
        fetchImpl: async () =>
          sseResponse(
            [
              'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":14}}}\n\n',
              'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_cut","name":"lookup_order"}}\n\n',
              'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"id\\":\\"A"}}\n\n',
              'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
              'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":256}}\n\n',
              'event: message_stop\ndata: {"type":"message_stop"}\n\n',
            ].join(""),
          ),
      });

      const chunks = await collect(provider.stream({ ...SAMPLE_REQUEST, tools: [SAMPLE_TOOL] }));
      expect(chunks).toEqual([
        { kind: "usage", tokensIn: 14, tokensOut: 256, stopReason: "length" },
      ]);
    });

    it("reports final usage before throwing on a completed malformed tool call", async () => {
      const provider = anthropicProvider({
        apiKey: "test-key",
        model: "claude-haiku-5-5",
        fetchImpl: async () =>
          sseResponse(
            [
              'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":14}}}\n\n',
              'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_bad","name":"lookup_order"}}\n\n',
              'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{not-json"}}\n\n',
              'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
              'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":9}}\n\n',
              'event: message_stop\ndata: {"type":"message_stop"}\n\n',
            ].join(""),
          ),
      });

      const { chunks, error } = await collectUntilThrow(
        provider.stream({ ...SAMPLE_REQUEST, tools: [SAMPLE_TOOL] }),
      );
      expect(error).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).retryable).toBe(false);
      expect(chunks).toEqual([{ kind: "usage", tokensIn: 14, tokensOut: 9, stopReason: "tools" }]);
    });
  });
});
