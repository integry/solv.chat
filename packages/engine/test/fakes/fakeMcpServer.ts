import { MCP_MAX_RESPONSE_BYTES } from "../../src/mcp/client.js";
import type { McpToolSpec } from "../../src/mcp/types.js";

export interface FakeMcpOptions {
  tools?: McpToolSpec[];
  /** name -> result text, or a function for per-input behaviour. */
  results?: Record<string, string | ((input: Record<string, unknown>) => string)>;
  /** Answer `tools/call` with isError: true. */
  failingTools?: string[];
  /** Never resolve `tools/call`, so the caller's timeout is what ends the request. */
  stall?: boolean;
  /** Return a body larger than the client's cap on `tools/call`. */
  oversize?: boolean;
  /** Return this HTTP status on `tools/call`. */
  status?: number;
}

export interface FakeMcpServer {
  fetchImpl: typeof fetch;
  /** Every JSON-RPC request, with its headers, so credentials can be asserted. */
  calls: Array<{ method: string; params: Record<string, unknown>; headers: Headers }>;
}

function jsonRpcOk(id: unknown, result: unknown, sessionId = "sess_fake_1"): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "mcp-session-id": sessionId,
    },
  });
}

/**
 * An MCP server as an injected `fetch`. No network, no transport guesswork
 * beyond what the client sends: the fake reads `method` from the JSON-RPC body
 * and answers it, so if the client's shape is wrong the fake does not answer
 * and the test fails loudly.
 */
export function fakeMcpServer(options: FakeMcpOptions = {}): FakeMcpServer {
  const calls: FakeMcpServer["calls"] = [];
  const failing = new Set(options.failingTools ?? []);

  const fetchImpl: typeof fetch = async (_input, init) => {
    const headers = new Headers(init?.headers);
    const rawBody = typeof init?.body === "string" ? init.body : "";
    const parsed = JSON.parse(rawBody) as {
      id?: unknown;
      method?: string;
      params?: Record<string, unknown>;
    };
    const method = parsed.method ?? "";
    const params = parsed.params ?? {};
    calls.push({ method, params, headers });

    if (method === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }

    if (method === "initialize") {
      return jsonRpcOk(parsed.id, {
        protocolVersion: "2025-11-25",
        capabilities: {},
        serverInfo: { name: "fake-mcp", version: "0.1.0" },
      });
    }

    if (method === "tools/list") {
      return jsonRpcOk(parsed.id, { tools: options.tools ?? [] });
    }

    if (method === "tools/call") {
      if (options.stall) {
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal?.aborted) {
            reject(new DOMException("The operation was aborted.", "AbortError"));
            return;
          }
          signal?.addEventListener(
            "abort",
            () => reject(new DOMException("The operation was aborted.", "AbortError")),
            { once: true },
          );
        });
      }

      if (options.status !== undefined && options.status !== 200) {
        return new Response("upstream error", { status: options.status });
      }

      if (options.oversize) {
        const big = "x".repeat(MCP_MAX_RESPONSE_BYTES + 1024);
        return jsonRpcOk(parsed.id, {
          content: [{ type: "text", text: big }],
          isError: false,
        });
      }

      const name = typeof params.name === "string" ? params.name : "";
      const args =
        typeof params.arguments === "object" && params.arguments !== null
          ? (params.arguments as Record<string, unknown>)
          : {};
      if (failing.has(name)) {
        return jsonRpcOk(parsed.id, {
          content: [{ type: "text", text: "tool failed" }],
          isError: true,
        });
      }

      const handler = options.results?.[name];
      const text = typeof handler === "function" ? handler(args) : (handler ?? "ok");
      return jsonRpcOk(parsed.id, {
        content: [{ type: "text", text }],
        isError: false,
      });
    }

    return new Response("Unknown method", { status: 400 });
  };

  return { fetchImpl, calls };
}
