import { MAX_ACTION_SCHEMA_BYTES } from "@solvchat/core";
import { describe, expect, it } from "vitest";
import {
  callTool,
  listTools,
  MCP_MAX_RESPONSE_BYTES,
  MCP_MAX_TOOL_RESULT_CHARS,
  MCP_MAX_TOOLS,
  McpError,
} from "../../src/index.js";

const SECRET = "test-header-value-do-not-leak";
const PUBLIC_HOST = async () => ["93.184.216.34"];

interface RecordedCall {
  url: string;
  init: RequestInit | undefined;
  body: Record<string, unknown>;
}

function fakeServer(reply: (body: Record<string, unknown>, call: RecordedCall) => Response): {
  impl: typeof fetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const impl: typeof fetch = async (input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const call: RecordedCall = { url: String(input), init, body };
    calls.push(call);
    return reply(body, call);
  };
  return { impl, calls };
}

function mcpServer(
  onMethod: (method: string, id: unknown, params: Record<string, unknown> | undefined) => Response,
  options: { sessionId?: string } = {},
) {
  return fakeServer((body) => {
    const method = String(body.method ?? "");
    if (method === "initialize") {
      return Response.json(
        {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: "2025-11-25",
            capabilities: { tools: {} },
            serverInfo: { name: "fake-mcp", version: "1.0.0" },
          },
        },
        options.sessionId ? { headers: { "mcp-session-id": options.sessionId } } : undefined,
      );
    }
    if (method === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }
    return onMethod(method, body.id, body.params as Record<string, unknown> | undefined);
  });
}

function sseResponse(events: Array<{ event?: string; data: unknown }>): Response {
  const payload = events
    .map((evt) => {
      const lines: string[] = [];
      if (evt.event) lines.push(`event: ${evt.event}`);
      lines.push(`data: ${typeof evt.data === "string" ? evt.data : JSON.stringify(evt.data)}`);
      return `${lines.join("\n")}\n\n`;
    })
    .join("");
  return new Response(payload, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("mcp client", () => {
  it("lists tools over JSON and echoes Mcp-Session-Id", async () => {
    const server = mcpServer(
      (method, id) => {
        expect(method).toBe("tools/list");
        return Response.json({
          jsonrpc: "2.0",
          id,
          result: {
            tools: [
              {
                name: "lookup_order",
                description: "Look up an order by id",
                inputSchema: {
                  type: "object",
                  properties: { orderId: { type: "string" } },
                  required: ["orderId"],
                },
              },
            ],
          },
        });
      },
      { sessionId: "sess-123" },
    );

    const tools = await listTools(
      { url: "https://tools.example.com/mcp", authKind: "none" },
      { fetchImpl: server.impl, resolveHost: PUBLIC_HOST },
    );

    expect(tools).toEqual([
      {
        name: "lookup_order",
        description: "Look up an order by id",
        inputSchema: {
          type: "object",
          properties: { orderId: { type: "string" } },
          required: ["orderId"],
        },
      },
    ]);

    expect(server.calls).toHaveLength(3);
    expect(new Headers(server.calls[0]?.init?.headers).get("accept")).toBe(
      "application/json, text/event-stream",
    );
    expect(new Headers(server.calls[1]?.init?.headers).get("mcp-session-id")).toBe("sess-123");
    expect(new Headers(server.calls[2]?.init?.headers).get("mcp-session-id")).toBe("sess-123");
    expect(new Headers(server.calls[2]?.init?.headers).get("mcp-protocol-version")).toBe(
      "2025-11-25",
    );
  });

  it("lists tools over SSE using readSseBlocks", async () => {
    const server = mcpServer((method, id) => {
      expect(method).toBe("tools/list");
      return sseResponse([
        {
          event: "message",
          data: { jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } },
        },
        {
          event: "message",
          data: {
            jsonrpc: "2.0",
            id,
            result: {
              tools: [
                {
                  name: "search_docs",
                  description: "Search docs",
                  inputSchema: { type: "object", properties: { q: { type: "string" } } },
                },
              ],
            },
          },
        },
      ]);
    });

    const tools = await listTools(
      { url: "https://tools.example.com/mcp", authKind: "none" },
      { fetchImpl: server.impl, resolveHost: PUBLIC_HOST },
    );

    expect(tools).toEqual([
      {
        name: "search_docs",
        description: "Search docs",
        inputSchema: { type: "object", properties: { q: { type: "string" } } },
      },
    ]);
  });

  it("calls a tool and handles text content, error results, and oversized content", async () => {
    const textServer = mcpServer((method, id, params) => {
      expect(method).toBe("tools/call");
      expect(params).toEqual({ name: "lookup_order", arguments: { id: "42" } });
      return Response.json({
        jsonrpc: "2.0",
        id,
        result: {
          content: [
            { type: "text", text: "Order #42" },
            { type: "image", data: "ignored", mimeType: "image/png" },
            { type: "text", text: "Status: shipped" },
          ],
        },
      });
    });

    const okResult = await callTool(
      { url: "https://tools.example.com/mcp", authKind: "none" },
      "lookup_order",
      { id: "42" },
      { fetchImpl: textServer.impl, resolveHost: PUBLIC_HOST },
    );
    expect(okResult).toEqual({ content: "Order #42\nStatus: shipped", isError: false });

    const errorServer = mcpServer((_method, id) =>
      Response.json({
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: "Order not found" }],
          isError: true,
        },
      }),
    );

    const errResult = await callTool(
      { url: "https://tools.example.com/mcp", authKind: "none" },
      "lookup_order",
      { id: "999" },
      { fetchImpl: errorServer.impl, resolveHost: PUBLIC_HOST },
    );
    expect(errResult).toEqual({ content: "Order not found", isError: true });

    const hugeText = "a".repeat(MCP_MAX_TOOL_RESULT_CHARS + 500);
    const hugeServer = mcpServer((_method, id) =>
      Response.json({
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: hugeText }],
        },
      }),
    );

    const cappedResult = await callTool(
      { url: "https://tools.example.com/mcp", authKind: "none" },
      "lookup_order",
      { id: "1" },
      { fetchImpl: hugeServer.impl, resolveHost: PUBLIC_HOST },
    );
    expect(cappedResult.content.length).toBe(MCP_MAX_TOOL_RESULT_CHARS);
    expect(cappedResult.isError).toBe(false);
  });

  it.each([
    ["http://tools.example.com/mcp", "not https"],
    ["https://localhost/mcp", "loopback host"],
    ["https://10.0.0.5/mcp", "private literal"],
  ])("refuses %s (%s) before making any request", async (url) => {
    const server = fakeServer(() => Response.json({}));
    await expect(
      listTools({ url, authKind: "none" }, { fetchImpl: server.impl, resolveHost: PUBLIC_HOST }),
    ).rejects.toBeInstanceOf(McpError);
    expect(server.calls).toHaveLength(0);
  });

  it("refuses a hostname resolving to a private address before making any request", async () => {
    const server = fakeServer(() => Response.json({}));
    await expect(
      listTools(
        { url: "https://private.example.com/mcp", authKind: "none" },
        { fetchImpl: server.impl, resolveHost: async () => ["127.0.0.1"] },
      ),
    ).rejects.toBeInstanceOf(McpError);
    expect(server.calls).toHaveLength(0);
  });

  it("refuses a redirect on POST rather than following it", async () => {
    const server = fakeServer(
      () =>
        new Response(null, {
          status: 307,
          headers: { location: "https://other.example.com/mcp" },
        }),
    );

    await expect(
      listTools(
        { url: "https://tools.example.com/mcp", authKind: "none" },
        { fetchImpl: server.impl, resolveHost: PUBLIC_HOST },
      ),
    ).rejects.toThrow(McpError);
    expect(server.calls).toHaveLength(1);
  });

  it("rejects an oversize response body", async () => {
    const server = mcpServer(
      () =>
        new Response("x".repeat(MCP_MAX_RESPONSE_BYTES + 1), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    await expect(
      listTools(
        { url: "https://tools.example.com/mcp", authKind: "none" },
        { fetchImpl: server.impl, resolveHost: PUBLIC_HOST },
      ),
    ).rejects.toMatchObject({ name: "McpError", failure: "too_large" });
  });

  it("times out a stalled body and cancels the stream", async () => {
    let cancelled = false;
    const server = mcpServer(() => {
      const stream = new TransformStream<Uint8Array, Uint8Array>();
      const writer = stream.writable.getWriter();
      writer.closed.catch(() => {
        cancelled = true;
      });
      void writer.write(new TextEncoder().encode("event: message\n")).catch(() => {});
      return new Response(stream.readable, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });

    await expect(
      listTools(
        { url: "https://tools.example.com/mcp", authKind: "none" },
        { fetchImpl: server.impl, resolveHost: PUBLIC_HOST, timeoutMs: 25 },
      ),
    ).rejects.toMatchObject({ name: "McpError", failure: "timeout" });
    expect(cancelled).toBe(true);
  });

  it("maps 500, 401, JSON-RPC error, and malformed result to typed McpError without server text", async () => {
    const server500 = fakeServer(() => new Response("internal stack trace", { status: 500 }));
    await expect(
      listTools(
        { url: "https://tools.example.com/mcp", authKind: "none" },
        { fetchImpl: server500.impl, resolveHost: PUBLIC_HOST },
      ),
    ).rejects.toSatisfy((err: unknown) => {
      return (
        err instanceof McpError &&
        err.failure === "unreachable" &&
        !err.message.includes("internal stack trace")
      );
    });

    const server401 = fakeServer(() => new Response("bad token", { status: 401 }));
    await expect(
      listTools(
        { url: "https://tools.example.com/mcp", authKind: "none" },
        { fetchImpl: server401.impl, resolveHost: PUBLIC_HOST },
      ),
    ).rejects.toMatchObject({ name: "McpError", failure: "unauthorized" });

    const rpcErrServer = mcpServer((_method, id) =>
      Response.json({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: "secret internal detail" },
      }),
    );
    await expect(
      listTools(
        { url: "https://tools.example.com/mcp", authKind: "none" },
        { fetchImpl: rpcErrServer.impl, resolveHost: PUBLIC_HOST },
      ),
    ).rejects.toSatisfy((err: unknown) => {
      return (
        err instanceof McpError &&
        err.failure === "protocol" &&
        !err.message.includes("secret internal detail")
      );
    });

    const malformedServer = mcpServer((_method, id) =>
      Response.json({
        jsonrpc: "2.0",
        id,
        result: { tools: "not-an-array" },
      }),
    );
    await expect(
      listTools(
        { url: "https://tools.example.com/mcp", authKind: "none" },
        { fetchImpl: malformedServer.impl, resolveHost: PUBLIC_HOST },
      ),
    ).rejects.toMatchObject({ name: "McpError", failure: "protocol" });
  });

  it("refuses servers offering more tools than MCP_MAX_TOOLS with the count named", async () => {
    const tooMany = Array.from({ length: MCP_MAX_TOOLS + 1 }, (_, i) => ({
      name: `tool_${i}`,
      description: "d",
      inputSchema: { type: "object" },
    }));
    const server = mcpServer((_method, id) =>
      Response.json({
        jsonrpc: "2.0",
        id,
        result: { tools: tooMany },
      }),
    );

    await expect(
      listTools(
        { url: "https://tools.example.com/mcp", authKind: "none" },
        { fetchImpl: server.impl, resolveHost: PUBLIC_HOST },
      ),
    ).rejects.toSatisfy((err: unknown) => {
      return (
        err instanceof McpError &&
        err.failure === "protocol" &&
        err.message.includes(String(MCP_MAX_TOOLS + 1))
      );
    });
  });

  it("skips a tool whose inputSchema exceeds MAX_ACTION_SCHEMA_BYTES and keeps the rest", async () => {
    const oversizedSchema = {
      type: "object",
      properties: {
        big: { type: "string", description: "x".repeat(MAX_ACTION_SCHEMA_BYTES) },
      },
    };
    const server = mcpServer((_method, id) =>
      Response.json({
        jsonrpc: "2.0",
        id,
        result: {
          tools: [
            { name: "too_big", description: "oversized", inputSchema: oversizedSchema },
            { name: "small_ok", description: "fits", inputSchema: { type: "object" } },
          ],
        },
      }),
    );

    const tools = await listTools(
      { url: "https://tools.example.com/mcp", authKind: "none" },
      { fetchImpl: server.impl, resolveHost: PUBLIC_HOST },
    );
    expect(tools).toEqual([
      { name: "small_ok", description: "fits", inputSchema: { type: "object" } },
    ]);
  });

  it("sends the owner's static header once per request and never leaks it in errors", async () => {
    const server = fakeServer(() => new Response("boom", { status: 500 }));
    let caught: unknown;
    try {
      await listTools(
        {
          url: "https://tools.example.com/mcp",
          authKind: "static_header",
          headerName: "x-api-key",
          headerValue: SECRET,
        },
        { fetchImpl: server.impl, resolveHost: PUBLIC_HOST },
      );
    } catch (err) {
      caught = err;
    }

    const headers = new Headers(server.calls[0]?.init?.headers);
    expect(headers.get("x-api-key")).toBe(SECRET);
    expect(server.calls).toHaveLength(1);
    expect(caught).toBeInstanceOf(McpError);
    expect(String((caught as Error).message)).not.toContain(SECRET);
    expect(String((caught as Error).message)).not.toContain("boom");
  });

  it("follows nextCursor across pages within the same session", async () => {
    const server = mcpServer(
      (method, id, params) => {
        expect(method).toBe("tools/list");
        if (params?.cursor === undefined) {
          return Response.json({
            jsonrpc: "2.0",
            id,
            result: {
              tools: [
                {
                  name: "first_tool",
                  description: "First",
                  inputSchema: { type: "object" },
                },
              ],
              nextCursor: "page-2",
            },
          });
        }
        expect(params).toEqual({ cursor: "page-2" });
        return Response.json({
          jsonrpc: "2.0",
          id,
          result: {
            tools: [
              {
                name: "second_tool",
                description: "Second",
                inputSchema: { type: "object" },
              },
            ],
          },
        });
      },
      { sessionId: "sess-paged" },
    );

    const tools = await listTools(
      { url: "https://tools.example.com/mcp", authKind: "none" },
      { fetchImpl: server.impl, resolveHost: PUBLIC_HOST },
    );

    expect(tools).toEqual([
      { name: "first_tool", description: "First", inputSchema: { type: "object" } },
      { name: "second_tool", description: "Second", inputSchema: { type: "object" } },
    ]);
    // initialize, notifications/initialized, tools/list (page 1), tools/list (page 2)
    expect(server.calls).toHaveLength(4);
    expect(new Headers(server.calls[3]?.init?.headers).get("mcp-session-id")).toBe("sess-paged");
  });

  it("rejects when aggregate tools across pages exceed MCP_MAX_TOOLS", async () => {
    const page1Count = 40;
    const page2Count = MCP_MAX_TOOLS - page1Count + 1;
    const makePage = (offset: number, count: number) =>
      Array.from({ length: count }, (_, i) => ({
        name: `tool_${offset + i}`,
        description: "d",
        inputSchema: { type: "object" },
      }));

    const server = mcpServer((_method, id, params) => {
      if (params?.cursor === undefined) {
        return Response.json({
          jsonrpc: "2.0",
          id,
          result: {
            tools: makePage(0, page1Count),
            nextCursor: "page-2",
          },
        });
      }
      return Response.json({
        jsonrpc: "2.0",
        id,
        result: {
          tools: makePage(page1Count, page2Count),
        },
      });
    });

    await expect(
      listTools(
        { url: "https://tools.example.com/mcp", authKind: "none" },
        { fetchImpl: server.impl, resolveHost: PUBLIC_HOST },
      ),
    ).rejects.toSatisfy((err: unknown) => {
      return (
        err instanceof McpError &&
        err.failure === "protocol" &&
        err.message.includes(String(MCP_MAX_TOOLS + 1))
      );
    });
  });

  it("rejects JSON responses with mismatched id, missing id, or invalid jsonrpc envelope", async () => {
    const mismatchedIdServer = mcpServer(() =>
      Response.json({
        jsonrpc: "2.0",
        id: "another-request",
        result: { content: [{ type: "text", text: "Completed" }] },
      }),
    );
    await expect(
      callTool(
        { url: "https://tools.example.com/mcp", authKind: "none" },
        "lookup_order",
        { id: "42" },
        { fetchImpl: mismatchedIdServer.impl, resolveHost: PUBLIC_HOST },
      ),
    ).rejects.toMatchObject({ name: "McpError", failure: "protocol" });

    const missingIdServer = mcpServer(() =>
      Response.json({
        jsonrpc: "2.0",
        result: { content: [{ type: "text", text: "Completed" }] },
      }),
    );
    await expect(
      callTool(
        { url: "https://tools.example.com/mcp", authKind: "none" },
        "lookup_order",
        { id: "42" },
        { fetchImpl: missingIdServer.impl, resolveHost: PUBLIC_HOST },
      ),
    ).rejects.toMatchObject({ name: "McpError", failure: "protocol" });

    const badVersionServer = mcpServer((_method, id) =>
      Response.json({
        jsonrpc: "1.0",
        id,
        result: { content: [{ type: "text", text: "Completed" }] },
      }),
    );
    await expect(
      callTool(
        { url: "https://tools.example.com/mcp", authKind: "none" },
        "lookup_order",
        { id: "42" },
        { fetchImpl: badVersionServer.impl, resolveHost: PUBLIC_HOST },
      ),
    ).rejects.toMatchObject({ name: "McpError", failure: "protocol" });
  });

  it("ignores SSE notifications and mismatched/missing ids, and rejects if no matching response arrives", async () => {
    const onlyUnmatchedSse = mcpServer(() =>
      sseResponse([
        {
          event: "message",
          data: { jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } },
        },
        {
          event: "message",
          data: {
            jsonrpc: "2.0",
            id: "another-request",
            result: { content: [{ type: "text", text: "Wrong" }] },
          },
        },
        {
          event: "message",
          data: {
            jsonrpc: "2.0",
            result: { content: [{ type: "text", text: "No id" }] },
          },
        },
      ]),
    );
    await expect(
      callTool(
        { url: "https://tools.example.com/mcp", authKind: "none" },
        "lookup_order",
        { id: "42" },
        { fetchImpl: onlyUnmatchedSse.impl, resolveHost: PUBLIC_HOST },
      ),
    ).rejects.toMatchObject({ name: "McpError", failure: "protocol" });

    const matchedAfterNoiseSse = mcpServer((_method, id) =>
      sseResponse([
        {
          event: "message",
          data: { jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } },
        },
        {
          event: "message",
          data: {
            jsonrpc: "2.0",
            id: "another-request",
            result: { content: [{ type: "text", text: "Wrong" }] },
          },
        },
        {
          event: "message",
          data: {
            jsonrpc: "2.0",
            result: { content: [{ type: "text", text: "No id" }] },
          },
        },
        {
          event: "message",
          data: {
            jsonrpc: "2.0",
            id,
            result: { content: [{ type: "text", text: "Matched" }] },
          },
        },
      ]),
    );
    await expect(
      callTool(
        { url: "https://tools.example.com/mcp", authKind: "none" },
        "lookup_order",
        { id: "42" },
        { fetchImpl: matchedAfterNoiseSse.impl, resolveHost: PUBLIC_HOST },
      ),
    ).resolves.toEqual({ content: "Matched", isError: false });
  });

  it.each([
    ["missing protocolVersion", {}],
    ["empty protocolVersion", { protocolVersion: "" }],
    ["non-string protocolVersion", { protocolVersion: 123 }],
    ["unsupported protocolVersion", { protocolVersion: "2024-11-05" }],
  ])(
    "rejects %s during initialize without sending initialized notification or tool operations",
    async (_label, initResult) => {
      const listServer = fakeServer((body) =>
        Response.json({
          jsonrpc: "2.0",
          id: body.id,
          result: initResult,
        }),
      );
      await expect(
        listTools(
          { url: "https://tools.example.com/mcp", authKind: "none" },
          { fetchImpl: listServer.impl, resolveHost: PUBLIC_HOST },
        ),
      ).rejects.toSatisfy((err: unknown) => {
        return (
          err instanceof McpError &&
          err.failure === "protocol" &&
          !err.message.includes("2024-11-05")
        );
      });
      expect(listServer.calls).toHaveLength(1);
      expect(listServer.calls[0]?.body.method).toBe("initialize");

      const callServer = fakeServer((body) =>
        Response.json({
          jsonrpc: "2.0",
          id: body.id,
          result: initResult,
        }),
      );
      await expect(
        callTool(
          { url: "https://tools.example.com/mcp", authKind: "none" },
          "lookup_order",
          { id: "42" },
          { fetchImpl: callServer.impl, resolveHost: PUBLIC_HOST },
        ),
      ).rejects.toSatisfy((err: unknown) => {
        return (
          err instanceof McpError &&
          err.failure === "protocol" &&
          !err.message.includes("2024-11-05")
        );
      });
      expect(callServer.calls).toHaveLength(1);
      expect(callServer.calls[0]?.body.method).toBe("initialize");
    },
  );

  describe("conversation context headers", () => {
    function toolServer() {
      return mcpServer((method, id) =>
        method === "tools/call"
          ? Response.json({
              jsonrpc: "2.0",
              id,
              result: { content: [{ type: "text", text: "ok" }] },
            })
          : Response.json({ jsonrpc: "2.0", id, result: { tools: [] } }),
      );
    }
    const headersOf = (call: RecordedCall) => new Headers(call.init?.headers);

    it("puts them on every request of the session when the target carries a context", async () => {
      const server = toolServer();
      await callTool(
        {
          url: "https://mcp.example.com/rpc",
          authKind: "static_header",
          headerName: "Authorization",
          headerValue: SECRET,
          conversationContext: {
            assistantId: "ast_1",
            conversationId: "cnv_1",
            visitorId: "vis 1",
          },
        },
        "lookup",
        {},
        { fetchImpl: server.impl, resolveHost: PUBLIC_HOST },
      );
      expect(server.calls.map((c) => c.body.method)).toEqual([
        "initialize",
        "notifications/initialized",
        "tools/call",
      ]);
      for (const call of server.calls) {
        const headers = headersOf(call);
        expect(headers.get("Solv-Assistant-Id")).toBe("ast_1");
        expect(headers.get("Solv-Conversation-Id")).toBe("cnv_1");
        expect(headers.get("Solv-Visitor-Id")).toMatch(/^h_[0-9a-f]{32}$/);
        expect(headers.get("Authorization")).toBe(SECRET);
      }
    });

    it("sends none of them without a context", async () => {
      const server = toolServer();
      await listTools(
        { url: "https://mcp.example.com/rpc", authKind: "none" },
        { fetchImpl: server.impl, resolveHost: PUBLIC_HOST },
      );
      for (const call of server.calls) {
        const headers = headersOf(call);
        expect(headers.get("Solv-Assistant-Id")).toBeNull();
        expect(headers.get("Solv-Conversation-Id")).toBeNull();
        expect(headers.get("Solv-Visitor-Id")).toBeNull();
      }
    });

    it("never lets a context header replace a clashing auth header", async () => {
      const server = toolServer();
      await callTool(
        {
          url: "https://mcp.example.com/rpc",
          authKind: "static_header",
          // A row stored before the clash rule existed.
          headerName: "solv-visitor-id",
          headerValue: SECRET,
          conversationContext: { assistantId: "ast_1", visitorId: "vis_1" },
        },
        "lookup",
        {},
        { fetchImpl: server.impl, resolveHost: PUBLIC_HOST },
      );
      for (const call of server.calls) {
        const headers = headersOf(call);
        expect(headers.get("Solv-Visitor-Id")).toBe(SECRET);
        expect(headers.get("Solv-Assistant-Id")).toBe("ast_1");
      }
    });
  });
});
