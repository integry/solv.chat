import { MAX_ACTION_SCHEMA_BYTES, readSseBlocks } from "@solvchat/core";
import {
  assertPublicHttpsUrl,
  followCheckingEachHop,
  type HostResolver,
  readCapped,
  UnsafeUrlError,
} from "../security/urlGuard.js";
import { McpError, type McpTarget, type McpToolSpec } from "./types.js";

// Transport: MCP Streamable HTTP.
// Checked 2026-11-15 against:
// - https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
//   POST to endpoint with Accept: application/json, text/event-stream;
//   responses are application/json or text/event-stream (202 Accepted for
//   notifications); optional Mcp-Session-Id response header echoed on
//   subsequent requests along with MCP-Protocol-Version.
// - https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle
//   initialize ({ protocolVersion, capabilities, clientInfo }) ->
//   result { protocolVersion, capabilities, serverInfo }, followed by
//   notifications/initialized.
// - https://modelcontextprotocol.io/specification/2025-11-25/server/tools
//   tools/list -> result { tools: [{ name, description?, inputSchema }] };
//   tools/call ({ name, arguments }) -> result { content: [{ type: "text", text }], isError? }.
const JSON_RPC_VERSION = "2.0";
const MCP_PROTOCOL_VERSION = "2025-11-25";
const SUPPORTED_MCP_PROTOCOL_VERSIONS = new Set<string>([MCP_PROTOCOL_VERSION]);
const ACCEPT = "application/json, text/event-stream";
const CLIENT_INFO = { name: "solv.chat", version: "0.1.0" };

// Caps: the specification sets none for this path, so these are chosen.
// 10 s per invocation matches the sitemap fetch budget; 256 KiB is far more
// than a tool list or a tool result needs and far less than a Worker should buffer.
export const MCP_TIMEOUT_MS = 10_000;
export const MCP_MAX_RESPONSE_BYTES = 256 * 1024;
// A server offering more than this is misconfigured for this product: the
// tool list goes into every prompt.
export const MCP_MAX_TOOLS = 64;
// Bound flattened text content returned from a single tool call.
export const MCP_MAX_TOOL_RESULT_CHARS = 16_000;

const encoder = new TextEncoder();

export interface McpClientOptions {
  fetchImpl?: typeof fetch | undefined;
  resolveHost?: HostResolver | undefined;
  timeoutMs?: number | undefined;
}

interface SessionContext {
  url: URL;
  headers: Record<string, string>;
  fetchImpl: typeof fetch;
  resolveHost: HostResolver | undefined;
  timeoutMs: number;
  signal: AbortSignal;
  sessionId?: string | undefined;
  protocolVersion: string;
}

function authHeaders(target: McpTarget): Record<string, string> {
  if (target.authKind !== "static_header") return {};
  if (!target.headerName || !target.headerValue) {
    // Refusing beats calling without the credential: an unauthenticated call
    // can succeed against a misconfigured server and look like it worked.
    throw new McpError("unauthorized", "This server needs a credential that is not set.");
  }
  return { [target.headerName]: target.headerValue };
}

function mapGuardError(err: unknown): McpError {
  if (err instanceof McpError) return err;
  if (err instanceof UnsafeUrlError) {
    if (err.message === "url: request timed out") {
      return new McpError("timeout", "That server took too long to respond.");
    }
    if (err.message.startsWith("url: response exceeds ")) {
      return new McpError("too_large", "That server sent a response that is too large.");
    }
    if (
      err.message === "url: upstream returned HTTP 401" ||
      err.message === "url: upstream returned HTTP 403"
    ) {
      return new McpError("unauthorized", "That server rejected the credential.");
    }
    // The guard's message names the policy, never the response or credential.
    return new McpError("unreachable", err.message);
  }
  return new McpError("unreachable", "That server could not be reached.");
}

function capStreamBytes(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
): ReadableStream<Uint8Array> {
  let total = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        total += chunk.byteLength;
        if (total > maxBytes) {
          controller.error(
            new McpError("too_large", "That server sent a response that is too large."),
          );
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMatchingJsonRpcResponse(
  value: unknown,
  requestId: string,
): value is Record<string, unknown> {
  if (!isPlainRecord(value)) return false;
  if (value.jsonrpc !== JSON_RPC_VERSION) return false;
  if (value.id !== requestId) return false;
  return (value.result !== undefined) !== (value.error !== undefined);
}

async function readJsonRpcResponse(
  response: Response,
  requestId: string,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const parsed = Number(declaredLength);
    if (Number.isFinite(parsed) && parsed > MCP_MAX_RESPONSE_BYTES) {
      await response.body?.cancel().catch(() => {});
      throw new McpError("too_large", "That server sent a response that is too large.");
    }
  }

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("text/event-stream")) {
    if (!response.body) {
      throw new McpError("protocol", "That server sent a response this engine could not read.");
    }
    const capped = capStreamBytes(response.body, MCP_MAX_RESPONSE_BYTES);
    for await (const block of readSseBlocks(capped, {
      signal,
      mapReadError: mapGuardError,
    })) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(block.data);
      } catch {
        continue;
      }
      if (isMatchingJsonRpcResponse(parsed, requestId)) {
        return parsed;
      }
    }
    if (signal.aborted) {
      throw new McpError("timeout", "That server took too long to respond.");
    }
    throw new McpError("protocol", "That server sent a response this engine could not read.");
  }

  let text: string;
  try {
    text = await readCapped(response, MCP_MAX_RESPONSE_BYTES, signal);
  } catch (err) {
    throw mapGuardError(err);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new McpError("protocol", "That server sent a response this engine could not read.");
  }
  if (!isMatchingJsonRpcResponse(parsed, requestId)) {
    throw new McpError("protocol", "That server sent a response this engine could not read.");
  }
  return parsed;
}

async function postJsonRpc(
  ctx: SessionContext,
  body: string,
  includeSessionHeaders: boolean,
): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...ctx.headers,
  };
  if (includeSessionHeaders) {
    headers["mcp-protocol-version"] = ctx.protocolVersion;
    if (ctx.sessionId) {
      headers["mcp-session-id"] = ctx.sessionId;
    }
  }

  try {
    return await followCheckingEachHop(ctx.url, ctx.fetchImpl, {
      maxRedirects: 0,
      timeoutMs: ctx.timeoutMs,
      accept: ACCEPT,
      method: "POST",
      body,
      headers,
      signal: ctx.signal,
      resolveHost: ctx.resolveHost,
    });
  } catch (err) {
    throw mapGuardError(err);
  }
}

async function rpc(
  ctx: SessionContext,
  method: string,
  params: Record<string, unknown>,
  includeSessionHeaders: boolean,
): Promise<{ result: Record<string, unknown>; response: Response }> {
  const id = crypto.randomUUID();
  const body = JSON.stringify({
    jsonrpc: JSON_RPC_VERSION,
    id,
    method,
    params,
  });

  const response = await postJsonRpc(ctx, body, includeSessionHeaders);
  const payload = await readJsonRpcResponse(response, id, ctx.signal);
  if (payload.error !== undefined) {
    // The server's error text is not forwarded: on a tool call this string
    // reaches a model prompt, and on a refresh it reaches an owner's screen.
    throw new McpError("protocol", "That server rejected the request.");
  }
  if (!isPlainRecord(payload.result)) {
    throw new McpError("protocol", "That server sent a response this engine could not read.");
  }
  return { result: payload.result, response };
}

async function withSession<T>(
  target: McpTarget,
  options: McpClientOptions,
  fn: (ctx: SessionContext) => Promise<T>,
): Promise<T> {
  let url: URL;
  try {
    // The guard first, always: https only, no credentials in the URL, and no
    // private, loopback or link-local target, resolved as well as literal.
    url = assertPublicHttpsUrl(target.url);
  } catch (err) {
    throw mapGuardError(err);
  }

  const headers = authHeaders(target);
  const timeoutMs = options.timeoutMs ?? MCP_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const ctx: SessionContext = {
    url,
    headers,
    fetchImpl: options.fetchImpl ?? fetch,
    resolveHost: options.resolveHost,
    timeoutMs,
    signal: controller.signal,
    protocolVersion: MCP_PROTOCOL_VERSION,
  };

  try {
    const init = await rpc(
      ctx,
      "initialize",
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: CLIENT_INFO,
      },
      false,
    );
    const negotiatedVersion = init.result.protocolVersion;
    if (
      typeof negotiatedVersion !== "string" ||
      !SUPPORTED_MCP_PROTOCOL_VERSIONS.has(negotiatedVersion)
    ) {
      throw new McpError("protocol", "That server does not support a compatible protocol version.");
    }
    ctx.protocolVersion = negotiatedVersion;

    const sessionId = init.response.headers.get("mcp-session-id");
    if (sessionId) {
      ctx.sessionId = sessionId;
    }

    const notifResponse = await postJsonRpc(
      ctx,
      JSON.stringify({
        jsonrpc: JSON_RPC_VERSION,
        method: "notifications/initialized",
      }),
      true,
    );
    await notifResponse.body?.cancel().catch(() => {});

    return await fn(ctx);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Lists a server's tools. Called when the owner adds or refreshes a server, so
 * it is stricter about what it accepts: a tool stored here can appear in a prompt.
 */
export async function listTools(
  target: McpTarget,
  options: McpClientOptions = {},
): Promise<McpToolSpec[]> {
  return withSession(target, options, async (ctx) => {
    const tools: McpToolSpec[] = [];
    const seenCursors = new Set<string>();
    let totalRawCount = 0;
    let cursor: string | undefined;

    for (;;) {
      const params = cursor === undefined ? {} : { cursor };
      const { result } = await rpc(ctx, "tools/list", params, true);
      const raw = Array.isArray(result.tools) ? result.tools : null;
      if (raw === null) {
        throw new McpError("protocol", "That server did not return a tool list.");
      }

      totalRawCount += raw.length;
      if (totalRawCount > MCP_MAX_TOOLS) {
        // All or nothing: silently keeping the first 64 would make which tools
        // exist depend on the server's ordering.
        throw new McpError(
          "protocol",
          `That server offers ${totalRawCount} tools, which exceeds the limit of ${MCP_MAX_TOOLS}.`,
        );
      }

      for (const item of raw) {
        if (!isPlainRecord(item)) continue;
        const name = typeof item.name === "string" ? item.name.trim() : "";
        // Same name rule as a page action: a name that could read as prose would
        // let a server write into the tool list the model sees.
        if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(name)) continue;
        const schema = isPlainRecord(item.inputSchema) ? item.inputSchema : {};
        // One oversized schema skips that tool rather than failing the refresh:
        // the owner can still switch on the tools that fit.
        if (encoder.encode(JSON.stringify(schema)).byteLength > MAX_ACTION_SCHEMA_BYTES) continue;
        tools.push({
          name,
          description: typeof item.description === "string" ? item.description.slice(0, 500) : "",
          inputSchema: schema,
        });
      }

      if (
        result.nextCursor === undefined ||
        result.nextCursor === null ||
        result.nextCursor === ""
      ) {
        break;
      }
      if (typeof result.nextCursor !== "string" || seenCursors.has(result.nextCursor)) {
        throw new McpError("protocol", "That server sent a response this engine could not read.");
      }
      seenCursors.add(result.nextCursor);
      cursor = result.nextCursor;
    }

    return tools;
  });
}

export interface McpCallResult {
  /** Flattened text content, capped at `MCP_MAX_TOOL_RESULT_CHARS`. */
  content: string;
  /** The server said the call failed; the loop passes this to the model. */
  isError: boolean;
}

/** Calls one tool. `input` is whatever the model asked for, passed through. */
export async function callTool(
  target: McpTarget,
  name: string,
  input: Record<string, unknown>,
  options: McpClientOptions = {},
): Promise<McpCallResult> {
  return withSession(target, options, async (ctx) => {
    const { result } = await rpc(ctx, "tools/call", { name, arguments: input }, true);
    if (!Array.isArray(result.content)) {
      throw new McpError("protocol", "That server sent a response this engine could not read.");
    }
    const text = result.content
      .map((part) => {
        if (!isPlainRecord(part)) return "";
        // Text only. A server may return images or embedded resources; the model
        // here is a text model and a resource would just be bytes in a prompt.
        return part.type === "text" && typeof part.text === "string" ? part.text : "";
      })
      .filter((piece) => piece !== "")
      .join("\n");
    const capped =
      text.length > MCP_MAX_TOOL_RESULT_CHARS ? text.slice(0, MCP_MAX_TOOL_RESULT_CHARS) : text;
    return { content: capped, isError: result.isError === true };
  });
}
