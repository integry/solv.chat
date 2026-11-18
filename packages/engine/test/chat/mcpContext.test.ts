import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { defaultVersionConfig, parseChatEventLine } from "@solvchat/core";
import { beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/admin/ingestKeys.js";
import { createApp } from "../../src/app.js";
import { forPrincipal } from "../../src/db/tenant.js";
import type { McpToolSpec } from "../../src/mcp/types.js";
import { ANTHROPIC_MODELS } from "../../src/models.js";
import type { Embedder } from "../../src/providers/retrieval.js";
import type { LlmChunk, LlmProvider } from "../../src/providers/types.js";
import { sealSecret } from "../../src/security/secretBox.js";
import { type FakeMcpServer, fakeMcpServer } from "../fakes/fakeMcpServer.js";
import { memoryRetriever } from "../fakes/memoryRetriever.js";
import { fakeSeams, TEST_ORG_ID } from "../helpers/app.js";

const SECRET_KEY = "test-solv-secret-key-for-mcp-context";
const CREDENTIAL = "sk_readonly_context_test_token";
const INGEST_KEY = "ik_context_test_ingest_key";
const SERVER_ID = "mcp_00000000000000000001";
const SERVER_URL = "https://mcp.example/rpc";
const CONTEXT_HEADERS = ["Solv-Conversation-Id", "Solv-Visitor-Id", "Solv-Assistant-Id"];

const LOOKUP: McpToolSpec = {
  name: "lookup_order",
  description: "Look up an order status by id",
  inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
};

/** Each answer: the first model call asks for the tool, the second answers. */
function toolCallingProvider(): LlmProvider {
  let calls = 0;
  return {
    name: "anthropic",
    model: ANTHROPIC_MODELS.fast.id,
    async *stream(): AsyncIterable<LlmChunk> {
      calls += 1;
      if (calls % 2 === 1) {
        yield {
          kind: "tool_call",
          call: { callId: "c_1", name: "lookup_order", input: { id: "1" } },
        };
      } else {
        yield { kind: "text", text: "Order 1 is shipped." };
      }
      yield { kind: "usage", tokensIn: 10, tokensOut: 5 };
    },
  };
}

function parseSse(text: string) {
  return text
    .trim()
    .split("\n\n")
    .filter(Boolean)
    .map((block) => {
      const lines = block.split("\n");
      const name =
        lines
          .find((l) => l.startsWith("event:"))
          ?.slice(6)
          .trim() ?? "";
      const data =
        lines
          .find((l) => l.startsWith("data:"))
          ?.slice(5)
          .trim() ?? "";
      return parseChatEventLine(name, data);
    });
}

async function sha256Prefix(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}

function contextOf(call: FakeMcpServer["calls"][number]) {
  return Object.fromEntries(CONTEXT_HEADERS.map((name) => [name, call.headers.get(name)]));
}

describe("conversation context headers to MCP servers", () => {
  const tenant = forPrincipal(env.DB, { orgId: TEST_ORG_ID, userId: "usr_a", role: "owner" });
  const embedder: Embedder = {
    dimensions: 3,
    async embed(texts, onBilled) {
      await onBilled(texts.length);
      return { vectors: texts.map(() => [1, 0, 0]) };
    },
  };
  let retriever = memoryRetriever();

  beforeEach(async () => {
    retriever = memoryRetriever();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM test_runs"),
      env.DB.prepare("DELETE FROM tests"),
      env.DB.prepare("DELETE FROM mcp_tools"),
      env.DB.prepare("DELETE FROM mcp_servers"),
      env.DB.prepare("DELETE FROM feedback"),
      env.DB.prepare("DELETE FROM messages"),
      env.DB.prepare("DELETE FROM conversations"),
      env.DB.prepare("DELETE FROM chunks"),
      env.DB.prepare("DELETE FROM documents"),
      env.DB.prepare("DELETE FROM sources"),
      env.DB.prepare("DELETE FROM assistant_versions"),
      env.DB.prepare("DELETE FROM assistants"),
    ]);
    await tenant.assistants.create({
      id: "ast_a",
      name: "Shop Bot",
      publicKey: "pk_shop_a",
      allowedOrigins: ["https://shop.example"],
      createdAt: 1000,
    });
    await env.DB.prepare("UPDATE assistants SET ingest_key_hash = ?1 WHERE id = 'ast_a'")
      .bind(await sha256Hex(INGEST_KEY))
      .run();
    const config = defaultVersionConfig();
    config.allowedTools = ["lookup_order"];
    const draft = await tenant.versions.createDraft({
      id: "ver_a1",
      assistantId: "ast_a",
      config,
      createdAt: 1000,
    });
    await tenant.versions.publishDraft("ast_a", draft.id, "ver_a2", 2000);
    await tenant.sources.create({
      id: "src_a",
      assistantId: "ast_a",
      kind: "push",
      label: "Docs",
      settings: {},
      createdAt: 1000,
    });
    await tenant.documents.upsert({
      id: "doc_a",
      sourceId: "src_a",
      externalId: "orders",
      url: "https://shop.example/orders",
      title: "Orders",
      contentHash: "hash_a",
      updatedAt: 1000,
    });
    await tenant.documents.replaceChunks("doc_a", [
      { id: "chk_a", ordinal: 0, text: "Orders ship within 2 days.", headingPath: "FAQ" },
    ]);
    await retriever.upsert([
      { chunkId: "chk_a", orgId: TEST_ORG_ID, assistantId: "ast_a", vector: [1, 0, 0] },
    ]);
  });

  async function seedServer(opts: { send?: boolean; headerName?: string } = {}) {
    await tenant.mcp.createServer({
      id: SERVER_ID,
      assistantId: "ast_a",
      label: "Orders",
      url: SERVER_URL,
      authKind: "static_header",
      headerName: opts.headerName ?? "Authorization",
      secretCiphertext: await sealSecret(SECRET_KEY, CREDENTIAL),
      enabled: true,
      createdAt: 1000,
      ...(opts.send === undefined ? {} : { sendConversationContext: opts.send }),
    });
    await tenant.mcp.upsertTool({
      id: "mcp_tool_lookup",
      serverId: SERVER_ID,
      name: LOOKUP.name,
      description: LOOKUP.description,
      inputSchema: LOOKUP.inputSchema,
    });
    await tenant.mcp.setToolAllowed("mcp_tool_lookup", true);
  }

  function appWith(server: FakeMcpServer) {
    return createApp(fakeSeams(), {
      fetch: server.fetchImpl,
      chat: { embedder, retriever, model: ANTHROPIC_MODELS.fast, provider: toolCallingProvider() },
    });
  }

  async function send(
    app: ReturnType<typeof createApp>,
    path: string,
    init: { method?: string; headers?: Record<string, string>; body?: unknown },
  ) {
    const ctx = createExecutionContext();
    const res = await app.fetch(
      new Request(`https://worker.example${path}`, {
        method: init.method ?? "POST",
        headers: {
          ...(init.body === undefined ? {} : { "content-type": "application/json" }),
          ...init.headers,
        },
        body: init.body === undefined ? null : JSON.stringify(init.body),
      }),
      { ...env, SOLV_SECRET_KEY: SECRET_KEY },
      ctx,
    );
    const text = await res.text();
    await waitOnExecutionContext(ctx);
    return { status: res.status, text };
  }

  const ask = (app: ReturnType<typeof createApp>, visitorId = "vis_1") =>
    send(app, "/v1/chat", {
      headers: { origin: "https://shop.example" },
      body: { protocol: 1, assistant: "pk_shop_a", visitorId, message: "Where is order 1?" },
    });

  const admin = (app: ReturnType<typeof createApp>, method: string, path: string, body?: unknown) =>
    send(app, path, { method, headers: { origin: "https://worker.example" }, body });

  it("sends all three on every request of a visitor's chat when the setting is on", async () => {
    await seedServer({ send: true });
    const server = fakeMcpServer({ tools: [LOOKUP], results: { lookup_order: "shipped" } });
    const res = await ask(appWith(server));
    const done = parseSse(res.text).find((e) => e?.type === "done");
    const conversationId = done?.type === "done" ? done.conversationId : "";
    expect(conversationId).toMatch(/^cnv_/);

    expect(server.calls.map((c) => c.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/call",
    ]);
    for (const call of server.calls) {
      expect(contextOf(call)).toEqual({
        "Solv-Conversation-Id": conversationId,
        "Solv-Visitor-Id": "vis_1",
        "Solv-Assistant-Id": "ast_a",
      });
      // The credential is still the credential.
      expect(call.headers.get("Authorization")).toBe(CREDENTIAL);
    }
    // Nothing else about the visitor goes out: no page, address or message.
    const names = [...(server.calls[2]?.headers.keys() ?? [])];
    expect(names.filter((n) => n.startsWith("solv-")).sort()).toEqual([
      "solv-assistant-id",
      "solv-conversation-id",
      "solv-visitor-id",
    ]);
  });

  it("sends a hash, never the raw value, for a visitor id outside the allowed characters", async () => {
    await seedServer({ send: true });
    const server = fakeMcpServer({ tools: [LOOKUP] });
    const visitorId = "visitor 1/é<script>";
    await ask(appWith(server), visitorId);
    const call = server.calls.find((c) => c.method === "tools/call");
    expect(call?.headers.get("Solv-Visitor-Id")).toBe(await sha256Prefix(visitorId));
  });

  it("sends none of them when the setting is off, and off is the default", async () => {
    await seedServer();
    const server = fakeMcpServer({ tools: [LOOKUP] });
    await ask(appWith(server));
    expect(server.calls.some((c) => c.method === "tools/call")).toBe(true);
    for (const call of server.calls) {
      expect(contextOf(call)).toEqual({
        "Solv-Conversation-Id": null,
        "Solv-Visitor-Id": null,
        "Solv-Assistant-Id": null,
      });
    }
  });

  it("sends the assistant id only from the Try it pane", async () => {
    await seedServer({ send: true });
    const server = fakeMcpServer({ tools: [LOOKUP] });
    const res = await admin(appWith(server), "POST", "/api/admin/chat", {
      protocol: 1,
      assistant: "pk_shop_a",
      visitorId: "vis_admin",
      message: "Where is order 1?",
    });
    expect(parseSse(res.text).some((e) => e?.type === "done")).toBe(true);
    expect(server.calls.some((c) => c.method === "tools/call")).toBe(true);
    for (const call of server.calls) {
      expect(contextOf(call)).toEqual({
        "Solv-Conversation-Id": null,
        "Solv-Visitor-Id": null,
        "Solv-Assistant-Id": "ast_a",
      });
    }
  });

  it("sends the assistant id only for answer tests run from the admin and from solv test", async () => {
    await seedServer({ send: true });
    await tenant.tests.create({
      id: "tst_1",
      assistantId: "ast_a",
      question: "Where is order 1?",
      expectation: { kind: "contains", phrase: "shipped" },
      createdAt: 1000,
    });

    const fromAdmin = fakeMcpServer({ tools: [LOOKUP] });
    const adminRun = await admin(
      appWith(fromAdmin),
      "POST",
      "/api/admin/assistants/ast_a/test-runs",
    );
    expect(adminRun.status).toBe(201);

    const fromCli = fakeMcpServer({ tools: [LOOKUP] });
    const cliRun = await send(appWith(fromCli), "/v1/ingest/ast_a/test-runs", {
      headers: { Authorization: `Bearer ${INGEST_KEY}` },
    });
    expect(cliRun.status).toBe(200);

    for (const server of [fromAdmin, fromCli]) {
      expect(server.calls.some((c) => c.method === "tools/call")).toBe(true);
      for (const call of server.calls) {
        expect(contextOf(call)).toEqual({
          "Solv-Conversation-Id": null,
          "Solv-Visitor-Id": null,
          "Solv-Assistant-Id": "ast_a",
        });
      }
    }
  });

  it("sends the assistant id only when the admin lists a server's tools", async () => {
    const server = fakeMcpServer({ tools: [LOOKUP] });
    const app = appWith(server);
    const created = await admin(app, "POST", "/api/admin/assistants/ast_a/mcp-servers", {
      label: "Orders",
      url: SERVER_URL,
      authKind: "none",
      sendConversationContext: true,
    });
    expect(created.status).toBe(201);
    const body = JSON.parse(created.text) as {
      server: { id: string; sendConversationContext: boolean };
      refreshError?: string;
    };
    expect(body.refreshError).toBeUndefined();
    expect(body.server.sendConversationContext).toBe(true);

    const refreshed = await admin(app, "POST", `/api/admin/mcp-servers/${body.server.id}/refresh`);
    expect(refreshed.status).toBe(200);

    expect(server.calls.filter((c) => c.method === "tools/list")).toHaveLength(2);
    for (const call of server.calls) {
      expect(contextOf(call)).toEqual({
        "Solv-Conversation-Id": null,
        "Solv-Visitor-Id": null,
        "Solv-Assistant-Id": "ast_a",
      });
    }

    // Switched off, the next listing carries nothing.
    const off = await admin(app, "PATCH", `/api/admin/mcp-servers/${body.server.id}`, {
      sendConversationContext: false,
    });
    expect(JSON.parse(off.text).server.sendConversationContext).toBe(false);
    server.calls.length = 0;
    await admin(app, "POST", `/api/admin/mcp-servers/${body.server.id}/refresh`);
    expect(server.calls.length).toBeGreaterThan(0);
    for (const call of server.calls) expect(call.headers.get("Solv-Assistant-Id")).toBeNull();
  });

  it("refuses to save a server whose auth header uses a context header name", async () => {
    const server = fakeMcpServer({ tools: [LOOKUP] });
    const app = appWith(server);
    for (const headerName of ["Solv-Conversation-Id", "solv-visitor-id", "SOLV-ASSISTANT-ID"]) {
      const res = await admin(app, "POST", "/api/admin/assistants/ast_a/mcp-servers", {
        label: "Clash",
        url: SERVER_URL,
        authKind: "static_header",
        headerName,
        headerValue: CREDENTIAL,
      });
      expect(res.status).toBe(400);
      expect(res.text).toContain("headerName");
      expect(res.text).toContain("Send conversation context");
    }
    expect(await tenant.mcp.listServers("ast_a")).toEqual([]);
    expect(server.calls).toEqual([]);

    await seedServer();
    const renamed = await admin(app, "PATCH", `/api/admin/mcp-servers/${SERVER_ID}`, {
      headerName: "Solv-Visitor-Id",
    });
    expect(renamed.status).toBe(400);
    expect((await tenant.mcp.getServer(SERVER_ID))?.headerName).toBe("Authorization");
  });

  it("refuses any save of a stored server whose header already clashes until it is renamed", async () => {
    await seedServer({ headerName: "Solv-Visitor-Id" });
    const app = appWith(fakeMcpServer({ tools: [LOOKUP] }));

    const turnOn = await admin(app, "PATCH", `/api/admin/mcp-servers/${SERVER_ID}`, {
      sendConversationContext: true,
    });
    expect(turnOn.status).toBe(400);
    expect(turnOn.text).toContain("Solv-Visitor-Id");
    expect((await tenant.mcp.getServer(SERVER_ID))?.sendConversationContext).toBe(false);

    const fixed = await admin(app, "PATCH", `/api/admin/mcp-servers/${SERVER_ID}`, {
      headerName: "X-Api-Key",
      sendConversationContext: true,
    });
    expect(fixed.status).toBe(200);
    const saved = await tenant.mcp.getServer(SERVER_ID);
    expect(saved?.headerName).toBe("X-Api-Key");
    expect(saved?.sendConversationContext).toBe(true);
  });

  it("refuses to turn the setting on with the ingest key while a server's header clashes", async () => {
    // A legacy row whose credential travels in Solv-Visitor-Id, sharing its
    // address with a server that is fine: nothing may change for either.
    await seedServer({ headerName: "Solv-Visitor-Id" });
    await tenant.mcp.createServer({
      id: "mcp_srv_other",
      assistantId: "ast_a",
      label: "Orders backup",
      url: SERVER_URL,
      authKind: "none",
      headerName: null,
      secretCiphertext: null,
      enabled: true,
      createdAt: 1001,
    });
    const server = fakeMcpServer({ tools: [LOOKUP] });
    const app = appWith(server);
    const auth = { Authorization: `Bearer ${INGEST_KEY}` };

    const turnOn = await send(app, "/v1/ingest/ast_a/mcp-servers", {
      method: "PUT",
      headers: auth,
      body: { servers: [{ url: SERVER_URL, sendConversationContext: true }] },
    });
    expect(turnOn.status).toBe(400);
    expect(turnOn.text).toContain("mcpServers[0].url");
    expect(turnOn.text).toContain("Choose another header name");
    expect(turnOn.text).not.toContain(CREDENTIAL);
    expect((await tenant.mcp.getServer(SERVER_ID))?.sendConversationContext).toBe(false);
    expect((await tenant.mcp.getServer("mcp_srv_other"))?.sendConversationContext).toBe(false);
    expect(server.calls).toEqual([]);

    // Turning it off (or leaving it off) is still allowed.
    const keepOff = await send(app, "/v1/ingest/ast_a/mcp-servers", {
      method: "PUT",
      headers: auth,
      body: { servers: [{ url: SERVER_URL, sendConversationContext: false }] },
    });
    expect(keepOff.status).toBe(200);
    expect(JSON.parse(keepOff.text).changed).toBe(0);
  });

  it("reads and sets the setting with the ingest key, as solv apply does", async () => {
    await seedServer();
    const app = appWith(fakeMcpServer());
    const auth = { Authorization: `Bearer ${INGEST_KEY}` };

    const before = await send(app, "/v1/ingest/ast_a/mcp-servers", {
      method: "GET",
      headers: auth,
    });
    expect(JSON.parse(before.text)).toEqual({
      servers: [
        { id: SERVER_ID, label: "Orders", url: SERVER_URL, sendConversationContext: false },
      ],
    });
    // Never the credential or its header.
    expect(before.text).not.toContain("Authorization");

    const put = await send(app, "/v1/ingest/ast_a/mcp-servers", {
      method: "PUT",
      headers: auth,
      body: { servers: [{ url: SERVER_URL, sendConversationContext: true }] },
    });
    expect(put.status).toBe(200);
    expect(JSON.parse(put.text).changed).toBe(1);

    const after = await send(app, "/v1/ingest/ast_a/mcp-servers", { method: "GET", headers: auth });
    expect(JSON.parse(after.text).servers[0].sendConversationContext).toBe(true);

    // An address with no server is refused and nothing changes.
    const unknown = await send(app, "/v1/ingest/ast_a/mcp-servers", {
      method: "PUT",
      headers: auth,
      body: {
        servers: [
          { url: SERVER_URL, sendConversationContext: false },
          { url: "https://other.example/mcp", sendConversationContext: true },
        ],
      },
    });
    expect(unknown.status).toBe(400);
    expect(unknown.text).toContain("mcpServers[1].url");
    expect((await tenant.mcp.getServer(SERVER_ID))?.sendConversationContext).toBe(true);

    const noKey = await send(app, "/v1/ingest/ast_a/mcp-servers", {
      method: "PUT",
      body: { servers: [{ url: SERVER_URL, sendConversationContext: false }] },
    });
    expect(noKey.status).toBe(401);
    expect((await tenant.mcp.getServer(SERVER_ID))?.sendConversationContext).toBe(true);
  });
});
