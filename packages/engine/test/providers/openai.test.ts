import { describe, expect, it, vi } from "vitest";
import { EmptyReplyError, ProviderError } from "../../src/providers/error.js";
import { openaiProvider } from "../../src/providers/openai.js";
import { REASONING_FALLBACK_MIN_OUTPUT_TOKENS } from "../../src/providers/reasoning.js";
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

const COMPLETE_TEXT_STREAM = [
  'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hello"}\n\n',
  'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":" world"}\n\n',
  'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","output":[],"usage":{"input_tokens":11,"output_tokens":5}}}\n\n',
].join("");

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

describe("openaiProvider", () => {
  it("streams text chunks in order, emits final usage, and sends key only in header", async () => {
    const fakeKey = "sk-openai-test-secret-do-not-leak";
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;

    const provider = openaiProvider({
      apiKey: fakeKey,
      model: "gpt-6-luna",
      fetchImpl: async (input, init) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        capturedInit = init;
        return sseResponse(COMPLETE_TEXT_STREAM);
      },
    });

    const chunks = await collect(provider.stream(SAMPLE_REQUEST));

    expect(chunks).toEqual([
      { kind: "text", text: "Hello" },
      { kind: "text", text: " world" },
      { kind: "usage", tokensIn: 11, tokensOut: 5, stopReason: "end" },
    ]);

    expect(capturedUrl).toBe("https://api.openai.com/v1/responses");
    expect(capturedUrl).not.toContain(fakeKey);
    const headers = new Headers(capturedInit?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${fakeKey}`);

    const body = JSON.parse(String(capturedInit?.body)) as Record<string, unknown>;
    expect(body).toEqual({
      model: "gpt-6-luna",
      instructions: "You are helpful.",
      input: [{ role: "user", content: "Hi" }],
      max_output_tokens: 256,
      stream: true,
      store: false,
    });
    expect("tools" in body).toBe(false);
  });

  it("throws ProviderError on mid-stream error event", async () => {
    const provider = openaiProvider({
      apiKey: "test-key",
      model: "gpt-6-luna",
      fetchImpl: async () =>
        sseResponse(
          [
            'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"partial"}\n\n',
            'event: error\ndata: {"type":"error","code":"server_error"}\n\n',
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
      model: "gpt-6-luna",
      fetchImpl: async () => new Response("rate limited", { status: 429 }),
    });
    await expect(collect(p429.stream(SAMPLE_REQUEST))).rejects.toMatchObject({
      name: "ProviderError",
      retryable: true,
      status: 429,
    });

    const p400 = openaiProvider({
      apiKey: secret,
      model: "gpt-6-luna",
      fetchImpl: async () => new Response("bad request", { status: 400 }),
    });
    await expect(collect(p400.stream(SAMPLE_REQUEST))).rejects.toMatchObject({
      name: "ProviderError",
      retryable: false,
      status: 400,
    });

    const p401 = openaiProvider({
      apiKey: secret,
      model: "gpt-6-luna",
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

  it("throws when stream ends without response.completed", async () => {
    const provider = openaiProvider({
      apiKey: "test-key",
      model: "gpt-6-luna",
      fetchImpl: async () =>
        sseResponse(
          'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"half"}\n\n',
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
            'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hello"}\n\n',
          ),
        );
      },
      cancel: cancelSpy,
    });

    const provider = openaiProvider({
      apiKey: "test-key",
      model: "gpt-6-luna",
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

  it("throws ProviderError when response.completed arrives without usage", async () => {
    const provider = openaiProvider({
      apiKey: "test-key",
      model: "gpt-6-luna",
      fetchImpl: async () =>
        sseResponse(
          [
            'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hello"}\n\n',
            'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n',
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
      model: "gpt-6-luna",
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
      model: "gpt-6-luna",
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
            'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"partial"}\n\n',
          ),
        );
      },
      pull() {
        return Promise.reject(new Error("stream connection dropped"));
      },
    });

    const provider = openaiProvider({
      apiKey: "test-key",
      model: "gpt-6-luna",
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
    const TEXT =
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hi"}\n\n';
    const COMPLETED =
      'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","output":[],"usage":{"input_tokens":11,"output_tokens":5}}}\n\n';
    const FAILED_WITH_USAGE =
      'event: response.failed\ndata: {"type":"response.failed","response":{"error":{"code":"server_error"},"usage":{"input_tokens":11,"output_tokens":5}}}\n\n';

    const cases: Array<[string, () => Response]> = [
      ["read fails after response.completed", () => failingAfter([TEXT, COMPLETED])],
      ["response.failed carrying usage", () => sseResponse([TEXT, FAILED_WITH_USAGE].join(""))],
    ];

    it.each(cases)("%s: yields one usage chunk, then throws", async (_name, respond) => {
      const provider = openaiProvider({
        apiKey: "test-key",
        model: "gpt-6-luna",
        fetchImpl: async () => respond(),
      });
      const { chunks, error } = await collectUntilThrow(provider.stream(SAMPLE_REQUEST));
      expect(error).toBeInstanceOf(ProviderError);
      expect(chunks.filter((c) => c.kind === "usage")).toEqual([
        {
          kind: "usage",
          tokensIn: 11,
          tokensOut: 5,
          ...(chunks.find((c) => c.kind === "usage")?.stopReason ? { stopReason: "end" } : {}),
        },
      ]);
    });

    it("yields no usage chunk when nothing was reported", async () => {
      const provider = openaiProvider({
        apiKey: "test-key",
        model: "gpt-6-luna",
        fetchImpl: async () => failingAfter([TEXT]),
      });
      const { chunks, error } = await collectUntilThrow(provider.stream(SAMPLE_REQUEST));
      expect(error).toBeInstanceOf(ProviderError);
      expect(chunks).toEqual([{ kind: "text", text: "Hi" }]);
    });
  });

  describe("tool calling (Responses API)", () => {
    it("serializes Responses API tools and tool-exchange input items", async () => {
      let body: Record<string, unknown> = {};
      const provider = openaiProvider({
        apiKey: "test-key",
        model: "gpt-6.1-sol",
        fetchImpl: async (_input, init) => {
          body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return sseResponse(COMPLETE_TEXT_STREAM);
        },
      });

      await collect(
        provider.stream({
          system: "You are helpful.",
          maxTokens: 256,
          tools: [SAMPLE_TOOL],
          messages: [
            { role: "user", content: "Check order A-1" },
            {
              role: "assistant",
              content: "Checking.",
              toolCalls: [{ callId: "call_1", name: "lookup_order", input: { id: "A-1" } }],
            },
            {
              role: "tool_results",
              results: [{ callId: "call_1", content: "shipped", isError: false }],
            },
          ],
        }),
      );

      expect(body).toEqual({
        model: "gpt-6.1-sol",
        instructions: "You are helpful.",
        max_output_tokens: 256,
        stream: true,
        store: false,
        tools: [
          {
            type: "function",
            name: "lookup_order",
            description: "Look up an order by id.",
            parameters: SAMPLE_TOOL.inputSchema,
            strict: false,
          },
        ],
        input: [
          { role: "user", content: "Check order A-1" },
          { role: "assistant", content: "Checking." },
          {
            type: "function_call",
            call_id: "call_1",
            name: "lookup_order",
            arguments: '{"id":"A-1"}',
          },
          {
            type: "function_call_output",
            call_id: "call_1",
            output: "shipped",
          },
        ],
      });
    });

    it("preserves optional tool parameters by setting strict: false on Responses tools", async () => {
      let body: Record<string, unknown> = {};
      const provider = openaiProvider({
        apiKey: "test-key",
        model: "gpt-6.1-sol",
        fetchImpl: async (_input, init) => {
          body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return sseResponse(COMPLETE_TEXT_STREAM);
        },
      });

      const toolWithOptionalParam: ToolDefinition = {
        name: "search_orders",
        description: "Search orders.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            limit: { type: "integer" },
          },
          required: ["query"],
        },
      };

      await collect(
        provider.stream({
          ...SAMPLE_REQUEST,
          tools: [toolWithOptionalParam],
        }),
      );

      expect(body.tools).toEqual([
        {
          type: "function",
          name: "search_orders",
          description: "Search orders.",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string" },
              limit: { type: "integer" },
            },
            required: ["query"],
          },
          strict: false,
        },
      ]);
    });

    it("distinguishes failed tool results from successful ones with identical content", async () => {
      const bodies: Array<Record<string, unknown>> = [];
      const provider = openaiProvider({
        apiKey: "test-key",
        model: "gpt-6.1-sol",
        fetchImpl: async (_input, init) => {
          bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          return sseResponse(COMPLETE_TEXT_STREAM);
        },
      });

      for (const isError of [false, true]) {
        await collect(
          provider.stream({
            system: "You are helpful.",
            maxTokens: 256,
            tools: [SAMPLE_TOOL],
            messages: [
              { role: "user", content: "Check order A-1" },
              {
                role: "assistant",
                content: "",
                toolCalls: [{ callId: "call_1", name: "lookup_order", input: { id: "A-1" } }],
              },
              {
                role: "tool_results",
                results: [
                  { callId: "call_1", content: "Unavailable", isError },
                  { callId: "call_2", content: "", isError },
                ],
              },
            ],
          }),
        );
      }

      const okInputs = bodies[0]?.input as Array<{ type?: string; output?: string }>;
      const errInputs = bodies[1]?.input as Array<{ type?: string; output?: string }>;
      const okOutputs = okInputs.filter((item) => item.type === "function_call_output");
      const errOutputs = errInputs.filter((item) => item.type === "function_call_output");

      expect(okOutputs).toEqual([
        { type: "function_call_output", call_id: "call_1", output: "Unavailable" },
        { type: "function_call_output", call_id: "call_2", output: "" },
      ]);
      expect(errOutputs).toEqual([
        { type: "function_call_output", call_id: "call_1", output: "[error] Unavailable" },
        { type: "function_call_output", call_id: "call_2", output: "[error]" },
      ]);
      expect(errOutputs[0]?.output).not.toBe(okOutputs[0]?.output);
      expect(errOutputs[1]?.output).not.toBe(okOutputs[1]?.output);
    });

    it("reassembles a tool call split across function_call_arguments.delta fragments and surfaces tools stopReason", async () => {
      const provider = openaiProvider({
        apiKey: "test-key",
        model: "gpt-6.1-sol",
        fetchImpl: async () =>
          sseResponse(
            [
              'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"lookup_order","arguments":""}}\n\n',
              'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","item_id":"fc_1","delta":"{\\"id\\":"}\n\n',
              'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","item_id":"fc_1","delta":"\\"A-1\\"}"}\n\n',
              'event: response.function_call_arguments.done\ndata: {"type":"response.function_call_arguments.done","item_id":"fc_1","arguments":"{\\"id\\":\\"A-1\\"}"}\n\n',
              'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","output":[{"type":"function_call"}],"usage":{"input_tokens":12,"output_tokens":4}}}\n\n',
            ].join(""),
          ),
      });

      const chunks = await collect(provider.stream({ ...SAMPLE_REQUEST, tools: [SAMPLE_TOOL] }));
      expect(chunks).toEqual([
        {
          kind: "tool_call",
          call: { callId: "call_1", name: "lookup_order", input: { id: "A-1" } },
        },
        { kind: "usage", tokensIn: 12, tokensOut: 4, stopReason: "tools" },
      ]);
    });

    it("yields text and tool_call chunks in arrival order", async () => {
      const provider = openaiProvider({
        apiKey: "test-key",
        model: "gpt-6-luna",
        fetchImpl: async () =>
          sseResponse(
            [
              'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Checking "}\n\n',
              'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":1,"item":{"type":"function_call","id":"fc_2","call_id":"call_2","name":"lookup_order","arguments":""}}\n\n',
              'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","item_id":"fc_2","delta":"{\\"id\\":\\"B-2\\"}"}\n\n',
              'event: response.function_call_arguments.done\ndata: {"type":"response.function_call_arguments.done","item_id":"fc_2","arguments":"{\\"id\\":\\"B-2\\"}"}\n\n',
              'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","output":[{"type":"function_call"}],"usage":{"input_tokens":15,"output_tokens":6}}}\n\n',
            ].join(""),
          ),
      });

      const chunks = await collect(provider.stream({ ...SAMPLE_REQUEST, tools: [SAMPLE_TOOL] }));
      expect(chunks).toEqual([
        { kind: "text", text: "Checking " },
        {
          kind: "tool_call",
          call: { callId: "call_2", name: "lookup_order", input: { id: "B-2" } },
        },
        { kind: "usage", tokensIn: 15, tokensOut: 6, stopReason: "tools" },
      ]);
    });

    it("surfaces length stopReason on response.incomplete with max_output_tokens", async () => {
      const provider = openaiProvider({
        apiKey: "test-key",
        model: "gpt-6-luna",
        fetchImpl: async () =>
          sseResponse(
            [
              'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Cut"}\n\n',
              'event: response.incomplete\ndata: {"type":"response.incomplete","response":{"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"usage":{"input_tokens":9,"output_tokens":256}}}\n\n',
            ].join(""),
          ),
      });

      const chunks = await collect(provider.stream(SAMPLE_REQUEST));
      expect(chunks).toEqual([
        { kind: "text", text: "Cut" },
        { kind: "usage", tokensIn: 9, tokensOut: 256, stopReason: "length" },
      ]);
    });

    it("turns malformed tool input JSON into a non-retryable ProviderError", async () => {
      const provider = openaiProvider({
        apiKey: "test-key",
        model: "gpt-6.1-sol",
        fetchImpl: async () =>
          sseResponse(
            [
              'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"fc_bad","call_id":"call_bad","name":"lookup_order","arguments":""}}\n\n',
              'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","item_id":"fc_bad","delta":"{not-json"}\n\n',
              'event: response.function_call_arguments.done\ndata: {"type":"response.function_call_arguments.done","item_id":"fc_bad","arguments":"{not-json"}\n\n',
            ].join(""),
          ),
      });

      const { chunks, error } = await collectUntilThrow(
        provider.stream({ ...SAMPLE_REQUEST, tools: [SAMPLE_TOOL] }),
      );
      expect(error).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).retryable).toBe(false);
      expect(chunks).toEqual([]);
    });

    it("suppresses truncated tool calls and preserves usage and length stopReason on max_output_tokens", async () => {
      const provider = openaiProvider({
        apiKey: "test-key",
        model: "gpt-6.1-sol",
        fetchImpl: async () =>
          sseResponse(
            [
              'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"fc_cut","call_id":"call_cut","name":"lookup_order","arguments":""}}\n\n',
              'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","item_id":"fc_cut","delta":"{\\"id\\":\\"A"}\n\n',
              'event: response.function_call_arguments.done\ndata: {"type":"response.function_call_arguments.done","item_id":"fc_cut","arguments":"{\\"id\\":\\"A"}\n\n',
              'event: response.incomplete\ndata: {"type":"response.incomplete","response":{"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"usage":{"input_tokens":14,"output_tokens":256}}}\n\n',
            ].join(""),
          ),
      });

      const chunks = await collect(provider.stream({ ...SAMPLE_REQUEST, tools: [SAMPLE_TOOL] }));
      expect(chunks).toEqual([
        { kind: "usage", tokensIn: 14, tokensOut: 256, stopReason: "length" },
      ]);
    });

    it("reports final usage before throwing on a completed malformed tool call", async () => {
      const provider = openaiProvider({
        apiKey: "test-key",
        model: "gpt-6.1-sol",
        fetchImpl: async () =>
          sseResponse(
            [
              'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"fc_bad","call_id":"call_bad","name":"lookup_order","arguments":""}}\n\n',
              'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","item_id":"fc_bad","delta":"{not-json"}\n\n',
              'event: response.function_call_arguments.done\ndata: {"type":"response.function_call_arguments.done","item_id":"fc_bad","arguments":"{not-json"}\n\n',
              'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","output":[{"type":"function_call"}],"usage":{"input_tokens":14,"output_tokens":9}}}\n\n',
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

  describe("reasoning off", () => {
    const OFF: LlmRequest = { ...SAMPLE_REQUEST, maxTokens: 64, reasoning: "off" };
    // A reasoning model that spent the limit before writing anything.
    const REASONING_ONLY_STREAM = [
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"type":"reasoning","id":"rs_1"}}\n\n',
      'event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"type":"reasoning","id":"rs_1"}}\n\n',
      'event: response.incomplete\ndata: {"type":"response.incomplete","response":{"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"output":[{"type":"reasoning"}],"usage":{"input_tokens":11,"output_tokens":64}}}\n\n',
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
      const { bodies, fetchImpl } = recording([() => sseResponse(COMPLETE_TEXT_STREAM)]);
      const provider = openaiProvider({ apiKey: "k", model: "gpt-6-luna", fetchImpl });
      await collect(provider.stream(SAMPLE_REQUEST));
      expect(bodies[0]).not.toHaveProperty("reasoning");
      expect(bodies[0]?.max_output_tokens).toBe(256);
    });

    it("asks for reasoning effort none, keeping the small limit", async () => {
      const { bodies, fetchImpl } = recording([() => sseResponse(COMPLETE_TEXT_STREAM)]);
      const provider = openaiProvider({ apiKey: "k", model: "gpt-6-luna", fetchImpl });
      await collect(provider.stream(OFF));
      expect(bodies).toHaveLength(1);
      expect(bodies[0]).toMatchObject({ reasoning: { effort: "none" }, max_output_tokens: 64 });
    });

    it("asks again without it, with room to reason, when the model refuses none", async () => {
      const { bodies, fetchImpl } = recording([
        () => new Response('{"error":{"message":"PROVIDER_TEXT"}}', { status: 400 }),
        () => sseResponse(COMPLETE_TEXT_STREAM),
      ]);
      const provider = openaiProvider({ apiKey: "k", model: "gpt-6.1-sol", fetchImpl });
      const chunks = await collect(provider.stream(OFF));
      expect(chunks[0]).toEqual({ kind: "text", text: "Hello" });
      expect(bodies).toHaveLength(2);
      expect(bodies[1]).not.toHaveProperty("reasoning");
      expect(bodies[1]?.max_output_tokens).toBe(REASONING_FALLBACK_MIN_OUTPUT_TOKENS);
      await collect(provider.stream(OFF));
      expect(bodies).toHaveLength(3);
      expect(bodies[2]).not.toHaveProperty("reasoning");
    });

    it("reports a reasoning-only reply as EmptyReplyError, after its usage", async () => {
      const { fetchImpl } = recording([() => sseResponse(REASONING_ONLY_STREAM)]);
      const provider = openaiProvider({ apiKey: "k", model: "gpt-6-luna", fetchImpl });
      const { chunks, error } = await collectUntilThrow(provider.stream(SAMPLE_REQUEST));
      expect(chunks).toEqual([
        { kind: "usage", tokensIn: 11, tokensOut: 64, stopReason: "length" },
      ]);
      expect(error).toBeInstanceOf(EmptyReplyError);
    });
  });

  describe("stop reasons", () => {
    // `output_tokens` includes reasoning (`output_tokens_details.reasoning_tokens`).
    function reasonedThenText(terminal: string): string {
      return [
        'event: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"type":"reasoning","id":"rs_1"}}\n\n',
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"CORS does not replace"}\n\n',
        terminal,
      ].join("");
    }
    const usage = {
      input_tokens: 40,
      output_tokens: 1024,
      output_tokens_details: { reasoning_tokens: 650 },
    };

    it.each([
      ["max_output_tokens", "length"],
      ["content_filter", "refused"],
    ] as const)("maps an incomplete %s to %s", async (reason, neutral) => {
      const terminal = `event: response.incomplete\ndata: ${JSON.stringify({ type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason }, usage } })}\n\n`;
      const fetchImpl = vi.fn(async () => sseResponse(reasonedThenText(terminal)));
      const provider = openaiProvider({ apiKey: "k", model: "gpt-6-luna", fetchImpl });
      const chunks = await collect(provider.stream(SAMPLE_REQUEST));
      expect(chunks).toEqual([
        { kind: "text", text: "CORS does not replace" },
        // Billed output, reasoning included: nothing is subtracted.
        { kind: "usage", tokensIn: 40, tokensOut: 1024, stopReason: neutral },
      ]);
    });

    it("maps a completed response to end and counts reasoning tokens as output", async () => {
      const terminal = `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [{ type: "reasoning" }, { type: "message" }], usage } })}\n\n`;
      const fetchImpl = vi.fn(async () => sseResponse(reasonedThenText(terminal)));
      const provider = openaiProvider({ apiKey: "k", model: "gpt-6-luna", fetchImpl });
      const chunks = await collect(provider.stream(SAMPLE_REQUEST));
      expect(chunks.at(-1)).toEqual({
        kind: "usage",
        tokensIn: 40,
        tokensOut: 1024,
        stopReason: "end",
      });
    });
  });
});
