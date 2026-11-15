import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { Conflict } from "../../src/admin/errors.js";
import {
  deleteMcpServer,
  refreshMcpTools,
  setMcpToolAllowed,
  updateMcpServer,
} from "../../src/admin/mcp.js";
import { createApp } from "../../src/app.js";
import { forPrincipal } from "../../src/db/tenant.js";
import { openSecret } from "../../src/security/secretBox.js";
import { type createTestApp, fakeSeams, TEST_ORG_ID } from "../helpers/app.js";

const ORG_A = TEST_ORG_ID;
const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb";
const TEST_SECRET_KEY = "test-secret-key-for-mcp-admin-tests";
const CREDENTIAL = "sk-live-super-secret-token-value";

interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

function mcpFetch(
  toolsOrHandler:
    | McpToolDef[]
    | ((method: string, id: unknown, requestHeaders: Headers) => Response),
  options: { requiredHeader?: { name: string; value: string } } = {},
): typeof fetch {
  return async (_input, init) => {
    const headers = new Headers(init?.headers);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const method = String(body.method ?? "");

    if (options.requiredHeader) {
      const actual = headers.get(options.requiredHeader.name);
      if (actual !== options.requiredHeader.value) {
        return new Response("Unauthorized", { status: 401 });
      }
    }

    if (method === "initialize") {
      return Response.json({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "fake-mcp", version: "1.0.0" },
        },
      });
    }
    if (method === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }
    if (typeof toolsOrHandler === "function") {
      return toolsOrHandler(method, body.id, headers);
    }
    if (method === "tools/list") {
      return Response.json({
        jsonrpc: "2.0",
        id: body.id,
        result: { tools: toolsOrHandler },
      });
    }
    return Response.json({
      jsonrpc: "2.0",
      id: body.id,
      error: { code: -32601, message: "Method not found" },
    });
  };
}

function appForOrg(orgId: string, fetchImpl?: typeof fetch) {
  return createApp(
    fakeSeams({
      auth: {
        async authenticate() {
          return { orgId, userId: "owner", role: "owner" };
        },
      },
    }),
    fetchImpl ? { fetch: fetchImpl } : undefined,
  );
}

async function call(
  app: ReturnType<typeof createTestApp>,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const ctx = createExecutionContext();
  const headers: Record<string, string> = {};
  if (method !== "GET" && method !== "HEAD") {
    headers.Origin = "https://example.com";
  }
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  const response = await app.fetch(
    new Request(`https://example.com${path}`, {
      method,
      headers,
      body: body === undefined ? null : JSON.stringify(body),
    }),
    { ...env, SOLV_SECRET_KEY: TEST_SECRET_KEY },
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

async function createAssistant(app: ReturnType<typeof createTestApp>, name = "Support Bot") {
  const res = await call(app, "POST", "/api/admin/assistants", {
    name,
    allowedOrigins: [],
  });
  const data = (await res.json()) as { assistant: { id: string } };
  return data.assistant.id;
}

describe("admin MCP servers and tools API", () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM mcp_tools"),
      env.DB.prepare("DELETE FROM mcp_servers"),
      env.DB.prepare("DELETE FROM assistant_versions"),
      env.DB.prepare("DELETE FROM assistants"),
      env.DB.prepare("DELETE FROM orgs WHERE id != ?1").bind(ORG_A),
      env.DB.prepare("INSERT INTO orgs (id, name) VALUES (?1, ?2)").bind(ORG_B, "Org B"),
    ]);
  });

  it("creates a server, lists tools with allowed = false, and never exposes credential or ciphertext", async () => {
    const app = appForOrg(
      ORG_A,
      mcpFetch(
        [
          {
            name: "lookup_order",
            description: "Look up an order by id",
            inputSchema: { type: "object", properties: { id: { type: "string" } } },
          },
          {
            name: "list_invoices",
            description: "List recent invoices",
            inputSchema: { type: "object" },
          },
        ],
        { requiredHeader: { name: "x-api-key", value: CREDENTIAL } },
      ),
    );
    const assistantId = await createAssistant(app);

    const createRes = await call(app, "POST", `/api/admin/assistants/${assistantId}/mcp-servers`, {
      label: "Orders",
      url: "https://tools.example.com/mcp",
      authKind: "static_header",
      headerName: "x-api-key",
      headerValue: CREDENTIAL,
    });
    expect(createRes.status).toBe(201);
    const createText = await createRes.text();
    const created = JSON.parse(createText) as {
      server: {
        id: string;
        label: string;
        url: string;
        authKind: string;
        headerName: string | null;
        hasSecret: boolean;
        enabled: boolean;
        toolCount: number;
        allowedCount: number;
      };
      tools: Array<{ id: string; name: string; allowed: boolean }>;
      refreshError?: string;
    };
    expect(created.refreshError).toBeUndefined();
    expect(created.server.authKind).toBe("static_header");
    expect(created.server.headerName).toBe("x-api-key");
    expect(created.server.hasSecret).toBe(true);
    expect(created.server.enabled).toBe(true);
    expect(created.server.toolCount).toBe(2);
    expect(created.server.allowedCount).toBe(0);
    expect(created.tools).toHaveLength(2);
    expect(created.tools.every((t) => t.allowed === false)).toBe(true);

    const row = await env.DB.prepare(
      "SELECT secret_ciphertext, auth_kind, enabled FROM mcp_servers WHERE org_id = ?1 AND id = ?2",
    )
      .bind(ORG_A, created.server.id)
      .first<{ secret_ciphertext: string | null; auth_kind: string; enabled: number }>();
    expect(row?.auth_kind).toBe("static_header");
    expect(row?.enabled).toBe(1);
    const ciphertext = row?.secret_ciphertext ?? "";
    expect(ciphertext).not.toBe("");
    // The stored form round-trips through openSecret at the call site.
    expect(await openSecret(TEST_SECRET_KEY, ciphertext)).toBe(CREDENTIAL);

    expect(createText).not.toContain(CREDENTIAL);
    expect(createText).not.toContain(ciphertext);

    for (const path of [
      `/api/admin/assistants/${assistantId}/mcp-servers`,
      `/api/admin/mcp-servers/${created.server.id}/tools`,
    ]) {
      const text = await (await call(app, "GET", path)).text();
      expect(text).not.toContain(CREDENTIAL);
      expect(text).not.toContain(ciphertext);
    }
  });

  it("keeps the server and reports refreshError when the remote server errors on create", async () => {
    const app = appForOrg(
      ORG_A,
      mcpFetch(() => new Response("Internal Server Error", { status: 500 })),
    );
    const assistantId = await createAssistant(app);

    const res = await call(app, "POST", `/api/admin/assistants/${assistantId}/mcp-servers`, {
      label: "Broken",
      url: "https://tools.example.com/mcp",
      authKind: "none",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      server: { id: string; toolCount: number };
      tools: unknown[];
      refreshError?: string;
    };
    expect(body.tools).toEqual([]);
    expect(body.server.toolCount).toBe(0);
    expect(body.refreshError).toBeTruthy();

    const listRes = await call(app, "GET", `/api/admin/assistants/${assistantId}/mcp-servers`);
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { servers: Array<{ id: string }> };
    expect(listBody.servers.map((s) => s.id)).toEqual([body.server.id]);
  });

  it("rejects non-https and private URLs with 400 naming url and creates no row", async () => {
    const app = appForOrg(ORG_A, mcpFetch([]));
    const assistantId = await createAssistant(app);

    for (const badUrl of ["http://tools.example.com/mcp", "https://127.0.0.1/mcp"]) {
      const res = await call(app, "POST", `/api/admin/assistants/${assistantId}/mcp-servers`, {
        label: "Bad",
        url: badUrl,
        authKind: "none",
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { fields?: string[] };
      expect(body.fields?.some((f) => f.startsWith("url:"))).toBe(true);
    }

    const countRow = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM mcp_servers WHERE org_id = ?1",
    )
      .bind(ORG_A)
      .first<{ count: number }>();
    expect(countRow?.count).toBe(0);
  });

  it("refresh adds new tools, updates changed tools, prunes dropped tools, and preserves allowed", async () => {
    let currentTools: McpToolDef[] = [
      {
        name: "lookup_order",
        description: "v1 description",
        inputSchema: { type: "object", properties: { id: { type: "string" } } },
      },
      {
        name: "deprecated_tool",
        description: "Will be removed",
        inputSchema: { type: "object" },
      },
    ];
    const app = appForOrg(
      ORG_A,
      mcpFetch((method, id) => {
        if (method === "tools/list") {
          return Response.json({ jsonrpc: "2.0", id, result: { tools: currentTools } });
        }
        return Response.json({ jsonrpc: "2.0", id, error: { code: -32601, message: "n/a" } });
      }),
    );
    const assistantId = await createAssistant(app);

    const createRes = await call(app, "POST", `/api/admin/assistants/${assistantId}/mcp-servers`, {
      label: "Orders",
      url: "https://tools.example.com/mcp",
      authKind: "none",
    });
    const created = (await createRes.json()) as {
      server: { id: string };
      tools: Array<{ id: string; name: string }>;
    };
    const lookupTool = created.tools.find((t) => t.name === "lookup_order");
    expect(lookupTool).toBeDefined();

    // Switch lookup_order on.
    const toggleRes = await call(
      app,
      "PATCH",
      `/api/admin/mcp-servers/${created.server.id}/tools/${lookupTool?.id}`,
      { allowed: true },
    );
    expect(toggleRes.status).toBe(200);

    // Second refresh: update lookup_order, add new_tool, drop deprecated_tool.
    currentTools = [
      {
        name: "lookup_order",
        description: "v2 description",
        inputSchema: { type: "object", properties: { orderId: { type: "string" } } },
      },
      {
        name: "new_tool",
        description: "Brand new",
        inputSchema: { type: "object" },
      },
    ];

    const refreshRes = await call(
      app,
      "POST",
      `/api/admin/mcp-servers/${created.server.id}/refresh`,
    );
    expect(refreshRes.status).toBe(200);
    const refreshed = (await refreshRes.json()) as {
      tools: Array<{ name: string; description: string; inputSchema: unknown; allowed: boolean }>;
    };
    expect(refreshed.tools).toHaveLength(2);

    const surviving = refreshed.tools.find((t) => t.name === "lookup_order");
    const added = refreshed.tools.find((t) => t.name === "new_tool");
    expect(surviving?.description).toBe("v2 description");
    expect(surviving?.inputSchema).toEqual({
      type: "object",
      properties: { orderId: { type: "string" } },
    });
    expect(surviving?.allowed).toBe(true);
    expect(added?.allowed).toBe(false);
    expect(refreshed.tools.find((t) => t.name === "deprecated_tool")).toBeUndefined();
  });

  it("keeps mcp_tools.allowed and draft allowedTools in step when toggling tools", async () => {
    const app = appForOrg(
      ORG_A,
      mcpFetch([
        { name: "tool_a", description: "A", inputSchema: { type: "object" } },
        { name: "tool_b", description: "B", inputSchema: { type: "object" } },
      ]),
    );
    const assistantId = await createAssistant(app);

    const createRes = await call(app, "POST", `/api/admin/assistants/${assistantId}/mcp-servers`, {
      label: "Tools",
      url: "https://tools.example.com/mcp",
      authKind: "none",
    });
    const created = (await createRes.json()) as {
      server: { id: string };
      tools: Array<{ id: string; name: string }>;
    };
    const toolA = created.tools.find((t) => t.name === "tool_a");
    expect(toolA).toBeDefined();

    // Switch on.
    const onRes = await call(
      app,
      "PATCH",
      `/api/admin/mcp-servers/${created.server.id}/tools/${toolA?.id}`,
      { allowed: true },
    );
    expect(onRes.status).toBe(200);
    expect(((await onRes.json()) as { tool: { allowed: boolean } }).tool.allowed).toBe(true);

    const draftAfterOn = (await (
      await call(app, "GET", `/api/admin/assistants/${assistantId}/draft`)
    ).json()) as { draft: { config: { allowedTools: string[] } } };
    expect(draftAfterOn.draft.config.allowedTools).toEqual(["tool_a"]);

    const tenant = forPrincipal(env.DB, { orgId: ORG_A, userId: "owner", role: "owner" });
    expect((await tenant.mcp.listAllowedTools(assistantId)).map((t) => t.name)).toEqual(["tool_a"]);

    // Switch off.
    const offRes = await call(
      app,
      "PATCH",
      `/api/admin/mcp-servers/${created.server.id}/tools/${toolA?.id}`,
      { allowed: false },
    );
    expect(offRes.status).toBe(200);
    expect(((await offRes.json()) as { tool: { allowed: boolean } }).tool.allowed).toBe(false);

    const draftAfterOff = (await (
      await call(app, "GET", `/api/admin/assistants/${assistantId}/draft`)
    ).json()) as { draft: { config: { allowedTools: string[] } } };
    expect(draftAfterOff.draft.config.allowedTools).toEqual([]);
    expect(await tenant.mcp.listAllowedTools(assistantId)).toEqual([]);
  });

  it("preserves credential when PATCH omits it, clears on empty string, and validates URL on PATCH", async () => {
    const app = appForOrg(
      ORG_A,
      mcpFetch([{ name: "ping", description: "Ping", inputSchema: { type: "object" } }], {
        requiredHeader: { name: "x-api-key", value: CREDENTIAL },
      }),
    );
    const assistantId = await createAssistant(app);

    const createRes = await call(app, "POST", `/api/admin/assistants/${assistantId}/mcp-servers`, {
      label: "Auth Server",
      url: "https://tools.example.com/mcp",
      authKind: "static_header",
      headerName: "x-api-key",
      headerValue: CREDENTIAL,
    });
    const created = (await createRes.json()) as { server: { id: string } };

    // PATCH omitting headerValue leaves credential untouched.
    const patchLabelRes = await call(app, "PATCH", `/api/admin/mcp-servers/${created.server.id}`, {
      label: "Renamed Server",
    });
    expect(patchLabelRes.status).toBe(200);
    const patchLabelText = await patchLabelRes.text();
    const patchLabelBody = JSON.parse(patchLabelText) as {
      server: { label: string; hasSecret: boolean };
    };
    expect(patchLabelBody.server.label).toBe("Renamed Server");
    expect(patchLabelBody.server.hasSecret).toBe(true);
    expect(patchLabelText).not.toContain(CREDENTIAL);

    // Refresh still succeeds using the preserved credential.
    const refreshOk = await call(
      app,
      "POST",
      `/api/admin/mcp-servers/${created.server.id}/refresh`,
    );
    expect(refreshOk.status).toBe(200);

    // PATCH with non-https URL fails with 400 naming url.
    const badUrlRes = await call(app, "PATCH", `/api/admin/mcp-servers/${created.server.id}`, {
      url: "http://tools.example.com/mcp",
    });
    expect(badUrlRes.status).toBe(400);
    const badUrlBody = (await badUrlRes.json()) as { fields?: string[] };
    expect(badUrlBody.fields?.some((f) => f.startsWith("url:"))).toBe(true);

    // PATCH with explicit empty string clears credential.
    const clearRes = await call(app, "PATCH", `/api/admin/mcp-servers/${created.server.id}`, {
      headerValue: "",
    });
    expect(clearRes.status).toBe(200);
    const clearBody = (await clearRes.json()) as { server: { hasSecret: boolean } };
    expect(clearBody.server.hasSecret).toBe(false);

    // With authKind still static_header and cleared secret, refresh fails cleanly (502).
    const refreshMissing = await call(
      app,
      "POST",
      `/api/admin/mcp-servers/${created.server.id}/refresh`,
    );
    expect(refreshMissing.status).toBe(502);
    const refreshMissingBody = (await refreshMissing.json()) as { error: string };
    expect(refreshMissingBody.error).toContain("credential that is not set");
  });

  it("returns 404 on every verb for another org's ids and leaves their rows untouched", async () => {
    const appA = appForOrg(
      ORG_A,
      mcpFetch([{ name: "secret_tool", description: "A", inputSchema: { type: "object" } }]),
    );
    const appB = appForOrg(ORG_B, mcpFetch([]));

    const assistantA = await createAssistant(appA, "Org A Bot");
    const createRes = await call(appA, "POST", `/api/admin/assistants/${assistantA}/mcp-servers`, {
      label: "Org A Server",
      url: "https://tools.example.com/mcp",
      authKind: "none",
    });
    const created = (await createRes.json()) as {
      server: { id: string };
      tools: Array<{ id: string }>;
    };
    const serverId = created.server.id;
    const toolId = created.tools[0]?.id ?? "";

    const checks: Array<[string, string, unknown?]> = [
      ["GET", `/api/admin/assistants/${assistantA}/mcp-servers`],
      [
        "POST",
        `/api/admin/assistants/${assistantA}/mcp-servers`,
        { label: "X", url: "https://tools.example.com/mcp", authKind: "none" },
      ],
      ["PATCH", `/api/admin/mcp-servers/${serverId}`, { label: "Hijacked" }],
      ["DELETE", `/api/admin/mcp-servers/${serverId}`],
      ["POST", `/api/admin/mcp-servers/${serverId}/refresh`],
      ["GET", `/api/admin/mcp-servers/${serverId}/tools`],
      ["PATCH", `/api/admin/mcp-servers/${serverId}/tools/${toolId}`, { allowed: true }],
    ];

    for (const [method, path, body] of checks) {
      const res = await call(appB, method, path, body);
      expect(res.status, `${method} ${path} should be 404 for another org`).toBe(404);
    }

    // Org A's server and tool are completely untouched.
    const listA = (await (
      await call(appA, "GET", `/api/admin/assistants/${assistantA}/mcp-servers`)
    ).json()) as { servers: Array<{ label: string; allowedCount: number }> };
    expect(listA.servers).toHaveLength(1);
    expect(listA.servers[0]?.label).toBe("Org A Server");
    expect(listA.servers[0]?.allowedCount).toBe(0);
  });

  it("deletes a server and its tools via the service path", async () => {
    const app = appForOrg(
      ORG_A,
      mcpFetch([{ name: "one_tool", description: "One", inputSchema: { type: "object" } }]),
    );
    const assistantId = await createAssistant(app);

    const createRes = await call(app, "POST", `/api/admin/assistants/${assistantId}/mcp-servers`, {
      label: "Temp",
      url: "https://tools.example.com/mcp",
      authKind: "none",
    });
    const created = (await createRes.json()) as { server: { id: string } };

    const delRes = await call(app, "DELETE", `/api/admin/mcp-servers/${created.server.id}`);
    expect(delRes.status).toBe(200);
    expect(await delRes.json()).toEqual({ deleted: true });

    const toolsRow = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM mcp_tools WHERE org_id = ?1 AND server_id = ?2",
    )
      .bind(ORG_A, created.server.id)
      .first<{ count: number }>();
    expect(toolsRow?.count).toBe(0);
  });

  it("exposes getToolByName and listAllowedTools filtered to enabled servers", async () => {
    const app = appForOrg(
      ORG_A,
      mcpFetch([
        { name: "enabled_tool", description: "Enabled", inputSchema: { type: "object" } },
        { name: "disabled_tool", description: "Off", inputSchema: { type: "object" } },
      ]),
    );
    const assistantId = await createAssistant(app);
    const createRes = await call(app, "POST", `/api/admin/assistants/${assistantId}/mcp-servers`, {
      label: "Server 1",
      url: "https://tools.example.com/mcp",
      authKind: "none",
    });
    const created = (await createRes.json()) as {
      server: { id: string };
      tools: Array<{ id: string; name: string }>;
    };
    const enabledTool = created.tools.find((t) => t.name === "enabled_tool");
    await call(
      app,
      "PATCH",
      `/api/admin/mcp-servers/${created.server.id}/tools/${enabledTool?.id}`,
      { allowed: true },
    );

    const tenant = forPrincipal(env.DB, { orgId: ORG_A, userId: "owner", role: "owner" });
    const byName = await tenant.mcp.getToolByName(created.server.id, "enabled_tool");
    expect(byName?.allowed).toBe(true);
    expect(await tenant.mcp.getToolByName(created.server.id, "missing")).toBeNull();
    expect((await tenant.mcp.listAllowedTools(assistantId)).map((t) => t.name)).toEqual([
      "enabled_tool",
    ]);

    // Disabling the server excludes its tools from listAllowedTools.
    await call(app, "PATCH", `/api/admin/mcp-servers/${created.server.id}`, { enabled: false });
    expect(await tenant.mcp.listAllowedTools(assistantId)).toEqual([]);
  });

  it("reconciles draft allowedTools when refresh prunes an allowed tool and preserves it if re-discovered", async () => {
    let currentTools: McpToolDef[] = [
      { name: "lookup_order", description: "Lookup", inputSchema: { type: "object" } },
      { name: "keep_me", description: "Keep", inputSchema: { type: "object" } },
    ];
    const app = appForOrg(
      ORG_A,
      mcpFetch((method, id) => {
        if (method === "tools/list") {
          return Response.json({ jsonrpc: "2.0", id, result: { tools: currentTools } });
        }
        return Response.json({ jsonrpc: "2.0", id, error: { code: -32601, message: "n/a" } });
      }),
    );
    const assistantId = await createAssistant(app);
    const created = (await (
      await call(app, "POST", `/api/admin/assistants/${assistantId}/mcp-servers`, {
        label: "Orders",
        url: "https://tools.example.com/mcp",
        authKind: "none",
      })
    ).json()) as { server: { id: string }; tools: Array<{ id: string; name: string }> };
    const lookupTool = created.tools.find((t) => t.name === "lookup_order");
    expect(lookupTool).toBeDefined();

    await call(
      app,
      "PATCH",
      `/api/admin/mcp-servers/${created.server.id}/tools/${lookupTool?.id}`,
      { allowed: true },
    );

    // Drop lookup_order from remote discovery and refresh.
    currentTools = [{ name: "keep_me", description: "Keep", inputSchema: { type: "object" } }];
    const refreshRes = await call(
      app,
      "POST",
      `/api/admin/mcp-servers/${created.server.id}/refresh`,
    );
    expect(refreshRes.status).toBe(200);

    const draftAfterPrune = (await (
      await call(app, "GET", `/api/admin/assistants/${assistantId}/draft`)
    ).json()) as { draft: { config: { allowedTools: string[] } } };
    expect(draftAfterPrune.draft.config.allowedTools).toEqual([]);

    // Re-adding lookup_order later inserts it with allowed = false and leaves draft empty.
    currentTools = [
      { name: "lookup_order", description: "Lookup", inputSchema: { type: "object" } },
      { name: "keep_me", description: "Keep", inputSchema: { type: "object" } },
    ];
    const reAddRes = await call(app, "POST", `/api/admin/mcp-servers/${created.server.id}/refresh`);
    expect(reAddRes.status).toBe(200);
    const reAdded = (await reAddRes.json()) as {
      tools: Array<{ name: string; allowed: boolean }>;
    };
    expect(reAdded.tools.find((t) => t.name === "lookup_order")?.allowed).toBe(false);

    const draftAfterReAdd = (await (
      await call(app, "GET", `/api/admin/assistants/${assistantId}/draft`)
    ).json()) as { draft: { config: { allowedTools: string[] } } };
    expect(draftAfterReAdd.draft.config.allowedTools).toEqual([]);
  });

  it("reconciles draft allowedTools on server deletion while preserving names allowed on another server", async () => {
    const app = appForOrg(
      ORG_A,
      mcpFetch([
        { name: "only_server1", description: "Only 1", inputSchema: { type: "object" } },
        { name: "shared_tool", description: "Shared", inputSchema: { type: "object" } },
      ]),
    );
    const assistantId = await createAssistant(app);

    const s1 = (await (
      await call(app, "POST", `/api/admin/assistants/${assistantId}/mcp-servers`, {
        label: "Server 1",
        url: "https://one.example.com/mcp",
        authKind: "none",
      })
    ).json()) as { server: { id: string }; tools: Array<{ id: string; name: string }> };

    const s2 = (await (
      await call(app, "POST", `/api/admin/assistants/${assistantId}/mcp-servers`, {
        label: "Server 2",
        url: "https://two.example.com/mcp",
        authKind: "none",
      })
    ).json()) as { server: { id: string }; tools: Array<{ id: string; name: string }> };

    for (const tool of s1.tools) {
      await call(app, "PATCH", `/api/admin/mcp-servers/${s1.server.id}/tools/${tool.id}`, {
        allowed: true,
      });
    }
    const s2Shared = s2.tools.find((t) => t.name === "shared_tool");
    await call(app, "PATCH", `/api/admin/mcp-servers/${s2.server.id}/tools/${s2Shared?.id}`, {
      allowed: true,
    });

    const delRes = await call(app, "DELETE", `/api/admin/mcp-servers/${s1.server.id}`);
    expect(delRes.status).toBe(200);

    const draftAfterDelete = (await (
      await call(app, "GET", `/api/admin/assistants/${assistantId}/draft`)
    ).json()) as { draft: { config: { allowedTools: string[] } } };
    expect(draftAfterDelete.draft.config.allowedTools).toEqual(["shared_tool"]);
  });

  it("keeps draft allowedTools when disabling one server's tool if another server's tool with the same name remains allowed", async () => {
    const app = appForOrg(
      ORG_A,
      mcpFetch([{ name: "lookup_order", description: "Lookup", inputSchema: { type: "object" } }]),
    );
    const assistantId = await createAssistant(app);

    const s1 = (await (
      await call(app, "POST", `/api/admin/assistants/${assistantId}/mcp-servers`, {
        label: "Server 1",
        url: "https://one.example.com/mcp",
        authKind: "none",
      })
    ).json()) as { server: { id: string }; tools: Array<{ id: string; name: string }> };

    const s2 = (await (
      await call(app, "POST", `/api/admin/assistants/${assistantId}/mcp-servers`, {
        label: "Server 2",
        url: "https://two.example.com/mcp",
        authKind: "none",
      })
    ).json()) as { server: { id: string }; tools: Array<{ id: string; name: string }> };

    const t1 = s1.tools[0];
    const t2 = s2.tools[0];
    expect(t1).toBeDefined();
    expect(t2).toBeDefined();

    await call(app, "PATCH", `/api/admin/mcp-servers/${s1.server.id}/tools/${t1?.id}`, {
      allowed: true,
    });
    await call(app, "PATCH", `/api/admin/mcp-servers/${s2.server.id}/tools/${t2?.id}`, {
      allowed: true,
    });

    // Disable Server 1's lookup_order; Server 2's lookup_order is still allowed.
    const disableFirst = await call(
      app,
      "PATCH",
      `/api/admin/mcp-servers/${s1.server.id}/tools/${t1?.id}`,
      { allowed: false },
    );
    expect(disableFirst.status).toBe(200);

    const tenant = forPrincipal(env.DB, { orgId: ORG_A, userId: "owner", role: "owner" });
    expect((await tenant.mcp.listAllowedTools(assistantId)).map((t) => t.id)).toEqual([t2?.id]);

    const draftAfterFirst = (await (
      await call(app, "GET", `/api/admin/assistants/${assistantId}/draft`)
    ).json()) as { draft: { config: { allowedTools: string[] } } };
    expect(draftAfterFirst.draft.config.allowedTools).toEqual(["lookup_order"]);

    // Disable Server 2's lookup_order; now the name is removed from draft.
    const disableSecond = await call(
      app,
      "PATCH",
      `/api/admin/mcp-servers/${s2.server.id}/tools/${t2?.id}`,
      { allowed: false },
    );
    expect(disableSecond.status).toBe(200);

    const draftAfterSecond = (await (
      await call(app, "GET", `/api/admin/assistants/${assistantId}/draft`)
    ).json()) as { draft: { config: { allowedTools: string[] } } };
    expect(draftAfterSecond.draft.config.allowedTools).toEqual([]);
    expect(await tenant.mcp.listAllowedTools(assistantId)).toEqual([]);
  });

  it("commits tool allowed and draft allowedTools atomically on concurrent updates and conflicts", async () => {
    const app = appForOrg(
      ORG_A,
      mcpFetch([{ name: "lookup_order", description: "Lookup", inputSchema: { type: "object" } }]),
    );
    const assistantId = await createAssistant(app);
    const created = (await (
      await call(app, "POST", `/api/admin/assistants/${assistantId}/mcp-servers`, {
        label: "Server 1",
        url: "https://one.example.com/mcp",
        authKind: "none",
      })
    ).json()) as { server: { id: string }; tools: Array<{ id: string; name: string }> };
    const toolId = created.tools[0]?.id ?? "";
    const tenant = forPrincipal(env.DB, { orgId: ORG_A, userId: "owner", role: "owner" });

    // Simulate a competing draft update on every attempt: Conflict is thrown and neither side changes.
    let mutatingCalls = 0;
    const alwaysContendedTenant = {
      ...tenant,
      versions: {
        ...tenant.versions,
        async draft(id: string) {
          const row = await tenant.versions.draft(id);
          if (row !== null) {
            mutatingCalls++;
            // Mutate the draft right after reading so setToolAllowedWithDraft sees a stale config.
            await tenant.versions.updateDraft(
              assistantId,
              {
                ...row.config,
                behaviour: { ...row.config.behaviour, persona: `race-${mutatingCalls}` },
              },
              row,
            );
          }
          return row;
        },
      },
    };

    await expect(
      setMcpToolAllowed(alwaysContendedTenant, created.server.id, toolId, { allowed: true }),
    ).rejects.toBeInstanceOf(Conflict);

    const toolAfterConflict = await tenant.mcp.getToolByName(created.server.id, "lookup_order");
    const draftAfterConflict = await tenant.versions.draft(assistantId);
    expect(toolAfterConflict?.allowed).toBe(false);
    expect(draftAfterConflict?.config.allowedTools).toEqual([]);

    // Concurrent enable and disable on the same tool always leave mcp_tools.allowed and draft aligned.
    await Promise.allSettled([
      setMcpToolAllowed(tenant, created.server.id, toolId, { allowed: true }),
      setMcpToolAllowed(tenant, created.server.id, toolId, { allowed: false }),
    ]);

    const finalTool = await tenant.mcp.getToolByName(created.server.id, "lookup_order");
    const finalDraft = await tenant.versions.draft(assistantId);
    expect(finalDraft?.config.allowedTools.includes("lookup_order")).toBe(finalTool?.allowed);
  });

  it("revalidates counterpart tools on concurrent server deletions and refresh prunes (F4)", async () => {
    const app = appForOrg(
      ORG_A,
      mcpFetch([{ name: "lookup_order", description: "Lookup", inputSchema: { type: "object" } }]),
    );
    const assistantId = await createAssistant(app);
    const s1 = (await (
      await call(app, "POST", `/api/admin/assistants/${assistantId}/mcp-servers`, {
        label: "Server 1",
        url: "https://one.example.com/mcp",
        authKind: "none",
      })
    ).json()) as { server: { id: string }; tools: Array<{ id: string }> };
    const s2 = (await (
      await call(app, "POST", `/api/admin/assistants/${assistantId}/mcp-servers`, {
        label: "Server 2",
        url: "https://two.example.com/mcp",
        authKind: "none",
      })
    ).json()) as { server: { id: string }; tools: Array<{ id: string }> };

    const t1 = s1.tools[0]?.id ?? "";
    const t2 = s2.tools[0]?.id ?? "";
    await call(app, "PATCH", `/api/admin/mcp-servers/${s1.server.id}/tools/${t1}`, {
      allowed: true,
    });
    await call(app, "PATCH", `/api/admin/mcp-servers/${s2.server.id}/tools/${t2}`, {
      allowed: true,
    });

    const tenant = forPrincipal(env.DB, { orgId: ORG_A, userId: "owner", role: "owner" });

    // Force both concurrent refreshes to read listOtherAllowedToolNames before either prunes.
    let releaseFirstRefreshBarrier!: () => void;
    let refreshReads = 0;
    const refreshBarrier = new Promise<void>((resolve) => {
      releaseFirstRefreshBarrier = resolve;
    });
    const barrierRefreshTenant = {
      ...tenant,
      mcp: {
        ...tenant.mcp,
        async listOtherAllowedToolNames(astId: string, excludeId: string) {
          const res = await tenant.mcp.listOtherAllowedToolNames(astId, excludeId);
          refreshReads++;
          if (refreshReads === 1) {
            await refreshBarrier;
          } else if (refreshReads === 2) {
            releaseFirstRefreshBarrier();
          }
          return res;
        },
      },
    };

    const emptyFetch = mcpFetch([]);
    await Promise.all([
      refreshMcpTools(
        { tenant: barrierRefreshTenant, secretKey: TEST_SECRET_KEY, fetchImpl: emptyFetch },
        s1.server.id,
      ),
      refreshMcpTools(
        { tenant: barrierRefreshTenant, secretKey: TEST_SECRET_KEY, fetchImpl: emptyFetch },
        s2.server.id,
      ),
    ]);

    expect(await tenant.mcp.listAllowedTools(assistantId)).toEqual([]);
    expect((await tenant.versions.draft(assistantId))?.config.allowedTools).toEqual([]);

    // Re-add lookup_order on both servers and test concurrent deleteMcpServer with the same barrier.
    const oneToolFetch = mcpFetch([
      { name: "lookup_order", description: "Lookup", inputSchema: { type: "object" } },
    ]);
    const refreshed1 = await refreshMcpTools(
      { tenant, secretKey: TEST_SECRET_KEY, fetchImpl: oneToolFetch },
      s1.server.id,
    );
    const refreshed2 = await refreshMcpTools(
      { tenant, secretKey: TEST_SECRET_KEY, fetchImpl: oneToolFetch },
      s2.server.id,
    );
    await setMcpToolAllowed(tenant, s1.server.id, refreshed1[0]?.id ?? "", { allowed: true });
    await setMcpToolAllowed(tenant, s2.server.id, refreshed2[0]?.id ?? "", { allowed: true });

    let releaseDeleteBarrier!: () => void;
    let deleteReads = 0;
    const deleteBarrier = new Promise<void>((resolve) => {
      releaseDeleteBarrier = resolve;
    });
    const barrierDeleteTenant = {
      ...tenant,
      mcp: {
        ...tenant.mcp,
        async listOtherAllowedToolNames(astId: string, excludeId: string) {
          const res = await tenant.mcp.listOtherAllowedToolNames(astId, excludeId);
          deleteReads++;
          if (deleteReads === 1) {
            await deleteBarrier;
          } else if (deleteReads === 2) {
            releaseDeleteBarrier();
          }
          return res;
        },
      },
    };

    await Promise.all([
      deleteMcpServer(barrierDeleteTenant, s1.server.id),
      deleteMcpServer(barrierDeleteTenant, s2.server.id),
    ]);

    expect(await tenant.mcp.listServers(assistantId)).toEqual([]);
    expect((await tenant.versions.draft(assistantId))?.config.allowedTools).toEqual([]);
  });

  it("reads target URL and credential from one snapshot and updates them atomically (F5)", async () => {
    const app = appForOrg(ORG_A, mcpFetch([]));
    const assistantId = await createAssistant(app);
    const created = (await (
      await call(app, "POST", `/api/admin/assistants/${assistantId}/mcp-servers`, {
        label: "Server 1",
        url: "https://one.example.com/mcp",
        authKind: "static_header",
        headerName: "Authorization",
        headerValue: "Bearer cred-A",
      })
    ).json()) as { server: { id: string } };

    const tenant = forPrincipal(env.DB, { orgId: ORG_A, userId: "owner", role: "owner" });
    const observedPairs: Array<{ url: string; auth: string | null }> = [];
    const recordingFetch: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const auth = new Headers(init?.headers).get("Authorization");
      observedPairs.push({ url, auth });
      return mcpFetch([])(input, init);
    };

    await Promise.all([
      updateMcpServer({ tenant, secretKey: TEST_SECRET_KEY }, created.server.id, {
        url: "https://two.example.com/mcp",
        headerValue: "Bearer cred-B",
      }),
      refreshMcpTools(
        { tenant, secretKey: TEST_SECRET_KEY, fetchImpl: recordingFetch },
        created.server.id,
      ),
    ]);

    expect(observedPairs.length).toBeGreaterThan(0);
    for (const pair of observedPairs) {
      expect(
        (pair.url === "https://one.example.com/mcp" && pair.auth === "Bearer cred-A") ||
          (pair.url === "https://two.example.com/mcp" && pair.auth === "Bearer cred-B"),
      ).toBe(true);
    }
  });

  it("preserves omitted fields on concurrent partial PATCH updates (F6)", async () => {
    const app = appForOrg(ORG_A, mcpFetch([]));
    const assistantId = await createAssistant(app);
    const created = (await (
      await call(app, "POST", `/api/admin/assistants/${assistantId}/mcp-servers`, {
        label: "Original",
        url: "https://one.example.com/mcp",
        authKind: "static_header",
        headerName: "Authorization",
        headerValue: "Bearer cred-A",
      })
    ).json()) as { server: { id: string } };

    const tenant = forPrincipal(env.DB, { orgId: ORG_A, userId: "owner", role: "owner" });

    // Force both concurrent PATCHes to read the initial server row before either writes.
    let releaseGetBarrier!: () => void;
    let getCalls = 0;
    const getBarrier = new Promise<void>((resolve) => {
      releaseGetBarrier = resolve;
    });
    const barrierTenant = {
      ...tenant,
      mcp: {
        ...tenant.mcp,
        async getServer(id: string) {
          const row = await tenant.mcp.getServer(id);
          getCalls++;
          if (getCalls === 1) {
            await getBarrier;
          } else if (getCalls === 2) {
            releaseGetBarrier();
          }
          return row;
        },
      },
    };

    await Promise.all([
      updateMcpServer({ tenant: barrierTenant, secretKey: TEST_SECRET_KEY }, created.server.id, {
        enabled: false,
      }),
      updateMcpServer({ tenant: barrierTenant, secretKey: TEST_SECRET_KEY }, created.server.id, {
        label: "Renamed",
      }),
    ]);

    const afterDisjoint = await tenant.mcp.getServer(created.server.id);
    expect(afterDisjoint?.enabled).toBe(false);
    expect(afterDisjoint?.label).toBe("Renamed");

    // Concurrent authKind -> "none" and headerName update must not leave a headerName on authKind = "none".
    let releaseAuthBarrier!: () => void;
    let authGetCalls = 0;
    const authBarrier = new Promise<void>((resolve) => {
      releaseAuthBarrier = resolve;
    });
    const authBarrierTenant = {
      ...tenant,
      mcp: {
        ...tenant.mcp,
        async getServer(id: string) {
          const row = await tenant.mcp.getServer(id);
          authGetCalls++;
          if (authGetCalls === 1) {
            await authBarrier;
          } else if (authGetCalls === 2) {
            releaseAuthBarrier();
          }
          return row;
        },
      },
    };

    await Promise.all([
      updateMcpServer(
        { tenant: authBarrierTenant, secretKey: TEST_SECRET_KEY },
        created.server.id,
        { authKind: "none" },
      ),
      updateMcpServer(
        { tenant: authBarrierTenant, secretKey: TEST_SECRET_KEY },
        created.server.id,
        { headerName: "X-Api-Key" },
      ),
    ]);

    const afterAuth = await tenant.mcp.getServer(created.server.id);
    expect(afterAuth?.authKind).toBe("none");
    expect(afterAuth?.headerName).toBeNull();
  });

  it("commits discovered tool upserts and pruning atomically on concurrent refreshes (F7)", async () => {
    const app = appForOrg(ORG_A, mcpFetch([]));
    const assistantId = await createAssistant(app);
    const created = (await (
      await call(app, "POST", `/api/admin/assistants/${assistantId}/mcp-servers`, {
        label: "Server 1",
        url: "https://one.example.com/mcp",
        authKind: "none",
      })
    ).json()) as { server: { id: string } };

    const tenant = forPrincipal(env.DB, { orgId: ORG_A, userId: "owner", role: "owner" });

    // Force Request A (discovering ["tool_a"]) to pause after remote discovery
    // before its target re-read while Request B (discovering ["tool_b"]) runs to completion.
    let releaseRequestA!: () => void;
    const requestAGate = new Promise<void>((resolve) => {
      releaseRequestA = resolve;
    });
    let targetReads = 0;

    const gatedTenantA = {
      ...tenant,
      mcp: {
        ...tenant.mcp,
        async readTargetWithSecretCiphertext(id: string) {
          targetReads++;
          if (targetReads === 2) {
            await requestAGate;
          }
          return tenant.mcp.readTargetWithSecretCiphertext(id);
        },
      },
    };

    const fetchA = mcpFetch([
      { name: "tool_a", description: "Tool A", inputSchema: { type: "object" } },
    ]);
    const fetchB = mcpFetch([
      { name: "tool_b", description: "Tool B", inputSchema: { type: "object" } },
    ]);

    let signalDiscoveryA!: () => void;
    const discoveryADone = new Promise<void>((resolve) => {
      signalDiscoveryA = resolve;
    });
    const trackedFetchA: typeof fetch = async (input, init) => {
      const res = await fetchA(input, init);
      const body = JSON.parse(String(init?.body)) as { method?: string };
      if (body.method === "tools/list") {
        signalDiscoveryA();
      }
      return res;
    };

    const refreshA = refreshMcpTools(
      { tenant: gatedTenantA, secretKey: TEST_SECRET_KEY, fetchImpl: trackedFetchA },
      created.server.id,
    );

    await discoveryADone;

    const toolsB = await refreshMcpTools(
      { tenant, secretKey: TEST_SECRET_KEY, fetchImpl: fetchB },
      created.server.id,
    );
    expect(toolsB.map((t) => t.name)).toEqual(["tool_b"]);

    releaseRequestA();
    const toolsA = await refreshA;
    expect(toolsA.map((t) => t.name)).toEqual(["tool_a"]);

    const stored = await tenant.mcp.listTools(created.server.id);
    expect(stored.map((t) => t.name)).toEqual(["tool_a"]);
  });

  it("fences stale discovery results when target changes during refresh (F8)", async () => {
    const app = appForOrg(ORG_A, mcpFetch([]));
    const assistantId = await createAssistant(app);
    const created = (await (
      await call(app, "POST", `/api/admin/assistants/${assistantId}/mcp-servers`, {
        label: "Server 1",
        url: "https://one.example.com/mcp",
        authKind: "none",
      })
    ).json()) as { server: { id: string } };

    const tenant = forPrincipal(env.DB, { orgId: ORG_A, userId: "owner", role: "owner" });

    // Refresh A starts against endpoint A, then pauses during listRemoteTools.
    let releaseFetchA!: () => void;
    let signalFetchAStarted!: () => void;
    const fetchAGate = new Promise<void>((resolve) => {
      releaseFetchA = resolve;
    });
    const fetchAStarted = new Promise<void>((resolve) => {
      signalFetchAStarted = resolve;
    });

    const fetchByUrl: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === "https://one.example.com/mcp") {
        const body = JSON.parse(String(init?.body)) as { method?: string };
        if (body.method === "tools/list") {
          signalFetchAStarted();
          await fetchAGate;
        }
        return mcpFetch([
          { name: "tool_a", description: "Tool A", inputSchema: { type: "object" } },
        ])(input, init);
      }
      return mcpFetch([{ name: "tool_b", description: "Tool B", inputSchema: { type: "object" } }])(
        input,
        init,
      );
    };

    const refreshA = refreshMcpTools(
      { tenant, secretKey: TEST_SECRET_KEY, fetchImpl: fetchByUrl },
      created.server.id,
    );

    await fetchAStarted;

    // Owner PATCHes server to endpoint B, refreshes B, and enables tool_b.
    await updateMcpServer({ tenant, secretKey: TEST_SECRET_KEY }, created.server.id, {
      url: "https://two.example.com/mcp",
    });
    const toolsB = await refreshMcpTools(
      { tenant, secretKey: TEST_SECRET_KEY, fetchImpl: fetchByUrl },
      created.server.id,
    );
    const toolB = toolsB.find((t) => t.name === "tool_b");
    expect(toolB).toBeDefined();
    await setMcpToolAllowed(tenant, created.server.id, toolB?.id ?? "", { allowed: true });

    // Now Refresh A receives endpoint A's old catalog; it must not overwrite B's catalog or prune tool_b.
    releaseFetchA();
    const resultA = await refreshA;
    expect(resultA.map((t) => t.name)).toEqual(["tool_b"]);

    const storedTools = await tenant.mcp.listTools(created.server.id);
    expect(storedTools.map((t) => ({ name: t.name, allowed: t.allowed }))).toEqual([
      { name: "tool_b", allowed: true },
    ]);
    expect((await tenant.versions.draft(assistantId))?.config.allowedTools).toEqual(["tool_b"]);
  });

  it("rejects stale target snapshots in syncToolsWithDraft and replaceServerTools (F8)", async () => {
    const app = appForOrg(ORG_A, mcpFetch([]));
    const assistantId = await createAssistant(app);
    const created = (await (
      await call(app, "POST", `/api/admin/assistants/${assistantId}/mcp-servers`, {
        label: "Server 1",
        url: "https://one.example.com/mcp",
        authKind: "none",
      })
    ).json()) as { server: { id: string } };

    const tenant = forPrincipal(env.DB, { orgId: ORG_A, userId: "owner", role: "owner" });
    const staleSnapshot = await tenant.mcp.readTargetWithSecretCiphertext(created.server.id);
    expect(staleSnapshot).not.toBeNull();
    if (!staleSnapshot) return;

    await updateMcpServer({ tenant, secretKey: TEST_SECRET_KEY }, created.server.id, {
      url: "https://two.example.com/mcp",
    });
    await refreshMcpTools(
      {
        tenant,
        secretKey: TEST_SECRET_KEY,
        fetchImpl: mcpFetch([
          { name: "tool_b", description: "Tool B", inputSchema: { type: "object" } },
        ]),
      },
      created.server.id,
    );

    const draft = await tenant.versions.draft(assistantId);
    expect(draft).not.toBeNull();
    if (!draft) return;

    const synced = await tenant.mcp.syncToolsWithDraft({
      assistantId,
      serverId: created.server.id,
      expectedTarget: staleSnapshot,
      tools: [
        {
          id: "mcp_stale",
          serverId: created.server.id,
          name: "tool_a",
          description: "Stale",
          inputSchema: { type: "object" },
        },
      ],
      remoteNames: ["tool_a"],
      prunedAllowedNames: [],
      removedFromDraftNames: [],
      expectedDraft: draft,
      nextConfig: draft.config,
      hasDraftChange: false,
    });
    expect(synced).toBe(false);

    const replaced = await tenant.mcp.replaceServerTools(
      created.server.id,
      [
        {
          id: "mcp_stale_2",
          serverId: created.server.id,
          name: "tool_a",
          description: "Stale",
          inputSchema: { type: "object" },
        },
      ],
      staleSnapshot,
    );
    expect(replaced).toBe(false);

    expect((await tenant.mcp.listTools(created.server.id)).map((t) => t.name)).toEqual(["tool_b"]);

    // If the target keeps changing on every attempt, refreshMcpTools rejects with Conflict (409).
    let n = 0;
    const mutatingFetch: typeof fetch = async (input, init) => {
      const body = JSON.parse(String(init?.body)) as { method?: string };
      if (body.method === "tools/list") {
        n++;
        await updateMcpServer({ tenant, secretKey: TEST_SECRET_KEY }, created.server.id, {
          url: `https://changing-${n}.example.com/mcp`,
        });
      }
      return mcpFetch([])(input, init);
    };
    await expect(
      refreshMcpTools(
        { tenant, secretKey: TEST_SECRET_KEY, fetchImpl: mutatingFetch },
        created.server.id,
      ),
    ).rejects.toThrow(/changed while refreshing/i);
  });

  it("gates removeServerWithDraft and syncToolsWithDraft on guarded UPDATE success (F9)", async () => {
    const app = appForOrg(
      ORG_A,
      mcpFetch([{ name: "tool_x", description: "Tool X", inputSchema: { type: "object" } }]),
    );
    const assistantId = await createAssistant(app);
    const created = (await (
      await call(app, "POST", `/api/admin/assistants/${assistantId}/mcp-servers`, {
        label: "Server 1",
        url: "https://one.example.com/mcp",
        authKind: "none",
      })
    ).json()) as { server: { id: string }; tools: Array<{ id: string; name: string }> };

    const tenant = forPrincipal(env.DB, { orgId: ORG_A, userId: "owner", role: "owner" });
    const toolX = created.tools[0];
    expect(toolX).toBeDefined();
    if (!toolX) return;

    // 1. Direct batch check for removeServerWithDraft: if draft already equals nextConfig,
    //    the batch must return false and leave both mcp_tools and mcp_servers intact.
    await setMcpToolAllowed(tenant, created.server.id, toolX.id, { allowed: true });
    const draftWithX = await tenant.versions.draft(assistantId);
    expect(draftWithX?.config.allowedTools).toEqual(["tool_x"]);
    if (!draftWithX) return;

    await setMcpToolAllowed(tenant, created.server.id, toolX.id, { allowed: false });
    const draftWithoutX = await tenant.versions.draft(assistantId);
    expect(draftWithoutX?.config.allowedTools).toEqual([]);
    if (!draftWithoutX) return;

    const directRemove = await tenant.mcp.removeServerWithDraft({
      assistantId,
      serverId: created.server.id,
      serverAllowedNames: ["tool_x"],
      removedFromDraftNames: ["tool_x"],
      expectedDraft: draftWithX,
      nextConfig: draftWithoutX.config,
      hasDraftChange: true,
    });
    expect(directRemove).toBe(false);
    expect(await tenant.mcp.getServer(created.server.id)).not.toBeNull();
    expect((await tenant.mcp.listTools(created.server.id)).map((t) => t.name)).toEqual(["tool_x"]);

    // 2. Direct batch check for syncToolsWithDraft (hasDraftChange): if draft already equals
    //    nextConfig, the batch must return false and leave mcp_tools untouched.
    const snapshot = await tenant.mcp.readTargetWithSecretCiphertext(created.server.id);
    expect(snapshot).not.toBeNull();
    if (!snapshot) return;

    const directSync = await tenant.mcp.syncToolsWithDraft({
      assistantId,
      serverId: created.server.id,
      expectedTarget: snapshot,
      tools: [
        {
          id: "mcp_y",
          serverId: created.server.id,
          name: "tool_y",
          description: "Tool Y",
          inputSchema: { type: "object" },
        },
      ],
      remoteNames: ["tool_y"],
      prunedAllowedNames: ["tool_x"],
      removedFromDraftNames: ["tool_x"],
      expectedDraft: draftWithX,
      nextConfig: draftWithoutX.config,
      hasDraftChange: true,
    });
    expect(directSync).toBe(false);
    expect((await tenant.mcp.listTools(created.server.id)).map((t) => t.name)).toEqual(["tool_x"]);

    // 3. End-to-end concurrent deleteMcpServer while tool_x is disabled:
    //    must retry and succeed with { deleted: true } rather than deleting and returning 404.
    await setMcpToolAllowed(tenant, created.server.id, toolX.id, { allowed: true });
    let disabledOnce = false;
    const racingDeleteTenant = {
      ...tenant,
      mcp: {
        ...tenant.mcp,
        async listOtherAllowedToolNames(astId: string, excludeId: string) {
          const res = await tenant.mcp.listOtherAllowedToolNames(astId, excludeId);
          if (!disabledOnce) {
            disabledOnce = true;
            await setMcpToolAllowed(tenant, created.server.id, toolX.id, { allowed: false });
          }
          return res;
        },
      },
    };

    const deleteRes = await deleteMcpServer(racingDeleteTenant, created.server.id);
    expect(deleteRes).toEqual({ deleted: true });
    expect(await tenant.mcp.getServer(created.server.id)).toBeNull();
    expect(await tenant.mcp.listTools(created.server.id)).toEqual([]);
  });
});
