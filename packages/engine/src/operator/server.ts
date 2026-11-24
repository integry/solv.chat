import { isPlainObject, parseChatEventLine } from "@solvchat/core";
import type { AuthProvider, OperatorPrincipal } from "../seams/types.js";
import {
  availableTools,
  callOperatorTool,
  type mountOperatorTools,
  type OperationContext,
  toolException,
} from "./tools.js";

const VERSION = "2025-11-25";
const PAGE_SIZE = 20;
type RequestId = string | number | null;
const toolCursor = (name: string) => btoa(`tool:${name}`);
const rpc = (id: RequestId, result: unknown) =>
  Response.json({ jsonrpc: "2.0", id, result }, { headers: { "cache-control": "no-store" } });
const rpcError = (id: RequestId, code: number, message: string, status = 200) =>
  Response.json(
    { jsonrpc: "2.0", ...(id === null ? {} : { id }), error: { code, message } },
    {
      status,
      headers: { "cache-control": "no-store" },
    },
  );

function toolResult(data: Record<string, unknown>, isError = false) {
  const fields = Array.isArray(data.fields)
    ? data.fields
    : Array.isArray(data.errors)
      ? data.errors
      : [];
  const text = isError
    ? [data.error ?? data.message ?? "The operation failed.", ...fields].join(" ")
    : JSON.stringify(data);
  return {
    content: [{ type: "text", text }],
    structuredContent: data,
    ...(isError ? { isError: true } : {}),
  };
}

async function renderToolResponse(response: Response, toolName: string) {
  if (response.headers.get("content-type")?.startsWith("text/event-stream")) {
    const events = (await response.text()).split("\n\n").flatMap((frame) => {
      const match = /^event: ([^\n]+)\ndata: ([^\n]+)$/.exec(frame);
      if (!match?.[1] || !match[2]) return [];
      const event = parseChatEventLine(match[1], match[2]);
      return event.type === "unknown" ? [] : [event];
    });
    const answer = events.flatMap((event) => (event.type === "token" ? [event.text] : [])).join("");
    const failure = events.find((event) => event.type === "error");
    return toolResult(
      { answer, events, ...(failure ? { error: failure.message } : {}) },
      Boolean(failure),
    );
  }

  const data: unknown = await response.json();
  if (!isPlainObject(data))
    return toolResult({ error: "The operation returned an unexpected response." }, true);
  if (!response.ok && response.status === 404) {
    return toolResult(
      { ...data, error: "That item was not found. Check its ID using the relevant list tool." },
      true,
    );
  }
  if (toolName === "add_tool_server" && typeof data.refreshError === "string") {
    return toolResult(
      {
        ...data,
        error: `The server was added, but discovery failed: ${data.refreshError} Check the server settings and refresh its tools.`,
      },
      true,
    );
  }
  const failed =
    !response.ok ||
    (toolName === "test_provider_key" && data.ok === false) ||
    (["run_tests", "run_declared_tests"].includes(toolName) && data.passed === false);
  return toolResult(
    failed && !data.error && !data.message
      ? { ...data, error: "Some answer tests did not pass. Review the results before publishing." }
      : data,
    failed,
  );
}

/**
 * Stateless Streamable HTTP with JSON responses. There is no server-initiated
 * stream or MCP session ID, so each request can run in a different isolate.
 * https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#streamable-http
 */
export async function operatorMcp(
  request: Request,
  auth: AuthProvider,
  resource: string,
  catalog: ReturnType<typeof mountOperatorTools>,
  makeContext: (operator: OperatorPrincipal) => Pick<OperationContext, "admin" | "ingest">,
): Promise<Response> {
  const serverOrigin = new URL(resource).origin;
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== serverOrigin) {
    return rpcError(null, -32600, "Origin is not allowed.", 403);
  }

  if (!auth.operator) return new Response(null, { status: 404 });
  const operator = await auth.operator.authenticate(request, resource);
  if (!operator) {
    // https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization#authorization-server-discovery
    const error = request.headers.has("authorization") ? ', error="invalid_token"' : "";
    return new Response(null, {
      status: 401,
      headers: {
        "www-authenticate": `Bearer resource_metadata="${auth.operator.metadataUrl(resource)}"${error}`,
        "cache-control": "no-store",
      },
    });
  }

  // A missing header is accepted for the compatible 2025-03-26 HTTP transport.
  // https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#protocol-version-header
  const version = request.headers.get("mcp-protocol-version") ?? "2025-03-26";
  if (version !== VERSION && version !== "2025-03-26") {
    return rpcError(null, -32600, "Unsupported MCP-Protocol-Version.", 400);
  }
  if (request.method !== "POST") {
    return new Response(null, { status: 405, headers: { allow: "POST" } });
  }
  const accept = request.headers
    .get("accept")
    ?.split(",")
    .map((value) => value.split(";")[0]?.trim().toLowerCase());
  if (!accept?.includes("application/json") || !accept.includes("text/event-stream")) {
    return rpcError(
      null,
      -32600,
      "Accept must include application/json and text/event-stream.",
      406,
    );
  }
  if (
    request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json"
  ) {
    return rpcError(null, -32600, "Content-Type must be application/json.", 415);
  }

  let message: unknown;
  try {
    message = await request.json();
  } catch {
    return rpcError(null, -32700, "Invalid JSON.", 400);
  }
  if (
    !isPlainObject(message) ||
    message.jsonrpc !== "2.0" ||
    typeof message.method !== "string" ||
    (message.id !== undefined &&
      typeof message.id !== "string" &&
      (typeof message.id !== "number" || !Number.isSafeInteger(message.id)))
  ) {
    return rpcError(null, -32600, "Expected a single JSON-RPC 2.0 request or notification.", 400);
  }
  // https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/cancellation
  // Includes notifications/initialized and notifications/cancelled. There is no
  // server session to update. Writes already accepted still complete atomically
  // where their shared admin operation provides that guarantee.
  if (message.id === undefined) return new Response(null, { status: 202 });
  const { id, method } = message;
  const params = message.params === undefined ? {} : message.params;
  if (!isPlainObject(params)) return rpcError(id, -32602, "Expected a parameters object.");

  if (method === "initialize") {
    // https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle#initialization
    if (
      typeof params.protocolVersion !== "string" ||
      !isPlainObject(params.clientInfo) ||
      typeof params.clientInfo.name !== "string" ||
      typeof params.clientInfo.version !== "string" ||
      !isPlainObject(params.capabilities)
    ) {
      return rpcError(id, -32602, "Provide protocolVersion, capabilities, and clientInfo.");
    }
    return rpc(id, {
      protocolVersion: VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "solv.chat", version: "1" },
    });
  }
  // https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/ping
  if (method === "ping") return rpc(id, {});

  if (method === "tools/list") {
    const toolsByName = [...catalog.values()]
      .map(({ tool }) => tool)
      .sort((a, b) => a.name.localeCompare(b.name));
    const visible = await availableTools(auth, operator, toolsByName);
    // https://modelcontextprotocol.io/specification/2025-11-25/server/utilities/pagination
    const cursor = params.cursor;
    const anchor =
      cursor === undefined ? -1 : visible.findIndex((tool) => toolCursor(tool.name) === cursor);
    if (cursor !== undefined && (typeof cursor !== "string" || anchor < 0)) {
      return rpcError(id, -32602, "Invalid cursor. Start again without a cursor.");
    }
    const tools = visible.slice(anchor + 1, anchor + 1 + PAGE_SIZE);
    const last = tools.at(-1);
    return rpc(id, {
      tools,
      ...(last && anchor + 1 + tools.length < visible.length
        ? { nextCursor: toolCursor(last.name) }
        : {}),
    });
  }

  if (method === "tools/call") {
    const args = params.arguments === undefined ? {} : params.arguments;
    if (typeof params.name !== "string" || !isPlainObject(args)) {
      return rpcError(id, -32602, "Provide a tool name and an arguments object.");
    }
    const mounted = catalog.get(params.name);
    if (!mounted)
      return rpcError(id, -32602, "Unknown tool. Use tools/list for available operations.");
    const { tool, run } = mounted;
    if (operator.scope === "read" && !tool.annotations.readOnlyHint) {
      // https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization#scope-challenge-handling
      const denied = rpc(
        id,
        toolResult(
          {
            error:
              "This tool needs full access. Connect with a full-access credential to make changes.",
          },
          true,
        ),
      );
      return new Response(denied.body, {
        status: 403,
        headers: {
          "content-type": "application/json",
          "cache-control": "no-store",
          "www-authenticate": `Bearer error="insufficient_scope", scope="full", resource_metadata="${auth.operator.metadataUrl(resource)}"`,
        },
      });
    }
    try {
      if (!(await availableTools(auth, operator, [tool])).length) {
        return rpc(
          id,
          toolResult({ error: "Your role does not have access to this operation." }, true),
        );
      }
      if (auth.operator.checkCall && !(await auth.operator.checkCall(operator))) {
        return rpc(id, toolResult({ error: "Too many calls. Wait a minute and retry." }, true));
      }
      const response = run
        ? await run(args, operator)
        : await callOperatorTool(tool, args, {
            request,
            resource,
            operator,
            ...makeContext(operator),
          });
      return rpc(id, await renderToolResponse(response, tool.name));
    } catch (error) {
      return rpc(id, toolResult(toolException(error), true));
    }
  }

  return rpcError(id, -32601, "Method not found.");
}
