import { env, fetchMock, SELF } from "cloudflare:test";
import {
  type OAuthClientProvider,
  UnauthorizedError,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { describe, expect, it } from "vitest";
import { SINGLE_ORG_ID } from "../../src/seams/open/passwordAuth.js";
import { sha256Hex } from "../../src/util/crypto.js";

const ORIGIN = "https://operator.example";
const RESOURCE = `${ORIGIN}/mcp`;
const fixtureFetch: typeof fetch = (input, init) => SELF.fetch(input, init);
const clientFor = () => new Client({ name: "solv protocol test", version: "1" });
const admin = (path: string, cookie: string, method = "GET", body?: unknown) =>
  fixtureFetch(`${ORIGIN}/api/admin${path}`, {
    method,
    headers: { origin: ORIGIN, cookie, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

async function adminCookie() {
  const response = await admin("/login", "", "POST", { password: "fixture-admin-password" });
  expect(response.status).toBe(200);
  return response.headers.get("set-cookie")?.split(";")[0] ?? "";
}

async function personalToken(cookie: string, scope: "read" | "full") {
  const response = await admin("/operator-tokens", cookie, "POST", {
    name: `${scope} access`,
    scope,
  });
  expect(response.status).toBe(201);
  return response.json<{ id: string; token: string }>();
}

function rawMcp(
  method: string,
  token?: string,
  additionalHeaders?: Record<string, string>,
  params?: object,
  id: number | null = 7,
) {
  return fixtureFetch(RESOURCE, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-11-25",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...additionalHeaders,
    },
    body: JSON.stringify({ jsonrpc: "2.0", method, ...(id === null ? {} : { id }), params }),
  });
}

describe("operator MCP protocol in the open Worker", () => {
  it("initializes with the SDK, paginates, calls a tool, and distinguishes transport and tool errors", async () => {
    const cookie = await adminCookie();
    const { token, id } = await personalToken(cookie, "full");
    const client = clientFor();
    const transport = new StreamableHTTPClientTransport(new URL(RESOURCE), {
      fetch: fixtureFetch,
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    });
    try {
      await client.connect(transport);
      expect(client.getServerVersion()?.name).toBe("solv.chat");
      expect(await client.ping()).toEqual({});
      const first = await client.listTools();
      expect(first.nextCursor).toBeTruthy();
      const rest = await client.listTools({ cursor: first.nextCursor });
      expect(rest.tools.length).toBeGreaterThan(0);
      expect(rest.tools.some((tool) => first.tools.some(({ name }) => name === tool.name))).toBe(
        false,
      );
      await expect(client.listTools({ cursor: "invalid" })).rejects.toThrow(/invalid cursor/i);
      const read = await client.callTool({ name: "list_assistants" });
      expect(read.structuredContent).toEqual(await (await admin("/assistants", cookie)).json());
      expect(read.content).toEqual([
        { type: "text", text: JSON.stringify(read.structuredContent) },
      ]);
      const error = await client.callTool({
        name: "get_assistant",
        arguments: { assistantId: "missing" },
      });
      expect(error).toMatchObject({
        isError: true,
        content: [{ text: expect.stringContaining("Check its ID") }],
      });
      await expect(client.callTool({ name: "no_such_operation" })).rejects.toThrow(/unknown tool/i);
      expect((await rawMcp("ping", token, { origin: "https://different.example" })).status).toBe(
        403,
      );
      expect((await rawMcp("ping", token, { "mcp-protocol-version": "2020-01-01" })).status).toBe(
        400,
      );
      expect(
        (await rawMcp("notifications/initialized", token, undefined, undefined, null)).status,
      ).toBe(202);
      expect(
        (await rawMcp("notifications/cancelled", token, undefined, { requestId: 7 }, null)).status,
      ).toBe(202);
      const unauthenticated = await rawMcp("ping");
      expect(unauthenticated.headers.get("www-authenticate")).toContain(
        "/.well-known/oauth-protected-resource/mcp",
      );
      expect(unauthenticated.headers.get("access-control-allow-origin")).toBeNull();

      const listResponse = await admin("/operator-tokens", cookie);
      expect(await listResponse.clone().text()).not.toContain(token);
      expect((await listResponse.json<{ access: unknown[] }>()).access).toContainEqual(
        expect.objectContaining({ id, lastUsedAt: expect.any(Number) }),
      );
      const stored = await env.DB.prepare(
        "SELECT access_hash FROM operator_grants WHERE org_id = ? AND id = ?",
      )
        .bind(SINGLE_ORG_ID, id)
        .first();
      expect(stored).toEqual({ access_hash: await sha256Hex(token) });
      const deleted = await admin(`/operator-tokens/${id}`, cookie, "DELETE");
      expect(deleted.status).toBe(200);
      expect((await rawMcp("ping", token)).status).toBe(401);
    } finally {
      await client.close();
    }
  });

  it("filters write tools for read-only tokens and refuses direct calls and ingest keys", async () => {
    const cookie = await adminCookie();
    const { token } = await personalToken(cookie, "read");
    const client = clientFor();
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(RESOURCE), {
          fetch: fixtureFetch,
          requestInit: { headers: { authorization: `Bearer ${token}` } },
        }),
      );
      const names: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined);
        expect(page.tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
        names.push(...page.tools.map((tool) => tool.name));
        cursor = page.nextCursor;
      } while (cursor);
      expect(names).toContain("get_report");
      expect(names).not.toContain("create_assistant");
      const denied = await rawMcp("tools/call", token, undefined, {
        name: "create_assistant",
        arguments: { body: { name: "Blocked" } },
      });
      expect(denied.status).toBe(403);
      expect(denied.headers.get("www-authenticate")).toContain('error="insufficient_scope"');
      expect(await denied.json()).toMatchObject({ result: { isError: true } });
      const created = await admin("/assistants", cookie, "POST", {
        name: "Ingest key test",
        allowedOrigins: [],
      });
      const { ingestKey } = await created.json<{ ingestKey: string }>();
      expect((await rawMcp("ping", ingestKey)).status).toBe(401);
      expect((await fixtureFetch(RESOURCE, { headers: { cookie } })).status).toBe(401);
    } finally {
      await client.close();
    }
  });

  it("discovers OAuth with the SDK, signs in, uses PKCE, refreshes, and revokes a connection", async () => {
    let clientInfo: OAuthClientInformationMixed | undefined;
    let authUrl: URL | undefined;
    let verifier = "";
    let tokens: OAuthTokens | undefined;
    const provider: OAuthClientProvider = {
      redirectUrl: "http://127.0.0.1:40982/callback",
      clientMetadata: {
        client_name: "SDK Operator",
        redirect_uris: ["http://127.0.0.1:40982/callback"],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
      state: () => "fixture-state",
      clientInformation: () => clientInfo,
      saveClientInformation: (info) => {
        clientInfo = info;
      },
      redirectToAuthorization: (url) => {
        authUrl = url;
      },
      saveCodeVerifier: (value) => {
        verifier = value;
      },
      codeVerifier: () => verifier,
      tokens: () => tokens,
      saveTokens: (value) => {
        tokens = value;
      },
    };
    const transport = new StreamableHTTPClientTransport(new URL(RESOURCE), {
      fetch: fixtureFetch,
      authProvider: provider,
    });
    const anonymous = clientFor();
    try {
      await expect(anonymous.connect(transport)).rejects.toBeInstanceOf(UnauthorizedError);
      expect(authUrl?.searchParams.get("resource")).toBe(RESOURCE);
      expect(authUrl?.searchParams.get("code_challenge_method")).toBe("S256");

      const signin = await fixtureFetch(String(authUrl));
      expect(await signin.text()).toContain("Sign in to solv.chat");
      const query = new URLSearchParams(authUrl?.search);
      const authorize = (params: Record<string, string>, cookie = "", origin = ORIGIN) =>
        fixtureFetch(`${ORIGIN}/oauth/authorize`, {
          method: "POST",
          redirect: "manual",
          headers: { origin, cookie },
          body: new URLSearchParams({ ...Object.fromEntries(query), ...params }),
        });
      expect(
        (
          await authorize(
            { decision: "sign-in", password: "fixture-admin-password" },
            "",
            "https://wrong.example",
          )
        ).status,
      ).toBe(403);
      const login = await authorize({ decision: "sign-in", password: "fixture-admin-password" });
      expect(login.status).toBe(303);
      const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
      const consent = await fixtureFetch(new URL(login.headers.get("location") ?? "", ORIGIN), {
        headers: { cookie },
      });
      expect(await consent.text()).toContain("SDK Operator");
      const allowed = await authorize({ decision: "allow", access: "full" }, cookie);
      expect(allowed.status).toBe(303);
      const callback = new URL(allowed.headers.get("location") ?? "");
      expect(callback.searchParams.get("state")).toBe("fixture-state");
      const code = callback.searchParams.get("code") ?? "";
      const form = (path: string, body: Record<string, string>) =>
        fixtureFetch(`${ORIGIN}/oauth/${path}`, {
          method: "POST",
          body: new URLSearchParams({
            client_id: clientInfo?.client_id ?? "",
            resource: RESOURCE,
            ...body,
          }),
        });
      const codeRequest = {
        grant_type: "authorization_code",
        code,
        redirect_uri: String(provider.redirectUrl),
        code_verifier: verifier,
      };
      expect(
        await (await form("token", { ...codeRequest, code_verifier: "x".repeat(43) })).json(),
      ).toMatchObject({ error: "invalid_grant" });
      expect(
        await (
          await form("token", { ...codeRequest, resource: `${ORIGIN}/something-else` })
        ).json(),
      ).toMatchObject({ error: "invalid_target" });
      await transport.finishAuth(code);
      expect(tokens).toMatchObject({ scope: "full", refresh_token: expect.any(String) });
      expect((await form("token", codeRequest)).status).toBe(400);
      const active = clientFor();
      try {
        await active.connect(
          new StreamableHTTPClientTransport(new URL(RESOURCE), {
            fetch: fixtureFetch,
            authProvider: provider,
          }),
        );
        expect(
          (await active.callTool({ name: "list_assistants" })).structuredContent,
        ).toBeDefined();
      } finally {
        await active.close();
      }

      const firstRefresh = tokens?.refresh_token ?? "";
      const firstAccess = tokens?.access_token ?? "";
      const response = await form("token", {
        grant_type: "refresh_token",
        refresh_token: firstRefresh,
      });
      expect(response.status).toBe(200);
      const refreshed = await response.json<OAuthTokens>();
      expect(refreshed.refresh_token).not.toBe(firstRefresh);
      expect((await rawMcp("ping", firstAccess)).status).toBe(401);
      expect((await rawMcp("ping", refreshed.access_token)).status).toBe(200);
      const child = await rawMcp("tools/call", refreshed.access_token, undefined, {
        name: "create_personal_token",
        arguments: { body: { name: "Delegated", scope: "read" } },
      });
      const { result } = await child.json<{ result: { structuredContent: { token: string } } }>();
      expect((await rawMcp("ping", result.structuredContent.token)).status).toBe(200);
      expect((await form("revoke", { token: refreshed.refresh_token ?? "" })).status).toBe(200);
      expect((await rawMcp("ping", refreshed.access_token)).status).toBe(401);
      expect((await rawMcp("ping", result.structuredContent.token)).status).toBe(401);
      expect(
        (
          await form("token", {
            grant_type: "refresh_token",
            refresh_token: refreshed.refresh_token ?? "",
          })
        ).status,
      ).toBe(400);
    } finally {
      await anonymous.close();
    }
  });

  it("accepts a published client identity with a loopback callback and revokes refresh-token replays", async () => {
    const cookie = await adminCookie();
    const clientId = "https://identity.example/client.json";
    const redirect = "http://localhost:45812/callback";
    const verifier = "v".repeat(64);
    const challenge = btoa(
      String.fromCharCode(
        ...new Uint8Array(
          await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
        ),
      ),
    )
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const params = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirect,
      resource: RESOURCE,
      scope: "read",
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    fetchMock.activate();
    try {
      const dns = fetchMock.get("https://cloudflare-dns.com");
      dns
        .intercept({ path: /dns-query\?name=identity\.example&type=A$/ })
        .reply(200, { Status: 0, Answer: [{ type: 1, data: "93.184.215.14" }] })
        .persist();
      dns
        .intercept({ path: /dns-query\?name=identity\.example&type=AAAA$/ })
        .reply(200, { Status: 0, Answer: [] })
        .persist();
      fetchMock
        .get("https://identity.example")
        .intercept({ path: "/client.json" })
        .reply(
          200,
          {
            client_id: clientId,
            client_name: "Published client",
            redirect_uris: ["http://localhost/callback"],
            token_endpoint_auth_method: "none",
          },
          {
            headers: { "content-type": "application/json", "cache-control": "public, max-age=120" },
          },
        );
      const consent = await fixtureFetch(`${ORIGIN}/oauth/authorize?${params}`, {
        headers: { cookie },
      });
      expect(consent.status).toBe(200);
      expect(await consent.text()).toContain("Published client");
      const allowed = await fixtureFetch(`${ORIGIN}/oauth/authorize`, {
        method: "POST",
        redirect: "manual",
        headers: { cookie, origin: ORIGIN },
        body: new URLSearchParams({
          ...Object.fromEntries(params),
          decision: "allow",
          access: "read",
        }),
      });
      expect(allowed.status).toBe(303);
      const code = new URL(allowed.headers.get("location") ?? "").searchParams.get("code") ?? "";
      const tokenEndpoint = (fields: Record<string, string>) =>
        fixtureFetch(`${ORIGIN}/oauth/token`, {
          method: "POST",
          body: new URLSearchParams({ resource: RESOURCE, client_id: clientId, ...fields }),
        });
      const tokens = await (
        await tokenEndpoint({
          grant_type: "authorization_code",
          redirect_uri: redirect,
          code,
          code_verifier: verifier,
        })
      ).json<OAuthTokens>();
      expect(tokens.scope).toBe("read");
      const refresh = { grant_type: "refresh_token", refresh_token: tokens.refresh_token ?? "" };
      const rotated = await (await tokenEndpoint(refresh)).json<OAuthTokens>();
      expect((await rawMcp("ping", rotated.access_token)).status).toBe(200);
      expect(await (await tokenEndpoint(refresh)).json()).toEqual({ error: "invalid_grant" });
      expect((await rawMcp("ping", rotated.access_token)).status).toBe(401);
    } finally {
      fetchMock.deactivate();
    }
  });
});
