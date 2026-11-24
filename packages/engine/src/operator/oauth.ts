import { isPlainObject } from "@solvchat/core";
import type { AuthProvider, OperatorAuth, OperatorScope } from "../seams/types.js";
import { assertPublicHttpsUrl, fetchCapped, readCapped } from "../security/urlGuard.js";
import { constantTimeEqual, sha256Hex } from "../util/crypto.js";
import {
  ACCESS_TTL_SECONDS,
  base64url,
  CODE_TTL,
  GRANT_TTL,
  operatorCredentials,
  privateJson,
  randomCredential,
} from "./credentials.js";
import { oauthPage } from "./oauthPage.js";
import { OPERATOR_SCOPES } from "./scopes.js";

const AUTHORIZE = "/oauth/authorize";
const TOKEN = "/oauth/token";
const REGISTER = "/oauth/register";
const REVOKE = "/oauth/revoke";
const PROTECTED = "/.well-known/oauth-protected-resource";
const METADATA = "/.well-known/oauth-authorization-server";
const PKCE = /^[A-Za-z0-9._~-]{43,128}$/;
const encoder = new TextEncoder();

const oauthError = (error: string, status = 400, error_description?: string) =>
  privateJson({ error, ...(error_description ? { error_description } : {}) }, status);

function one(params: URLSearchParams, name: string): string | null {
  const items = params.getAll(name);
  return items.length === 1 ? (items[0] ?? null) : null;
}

async function form(request: Request): Promise<URLSearchParams | null> {
  const contentType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/x-www-form-urlencoded") return null;
  return readCapped(request, 16_384).then(
    (value) => new URLSearchParams(value),
    () => null,
  );
}

function loopback(url: URL): boolean {
  return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

function redirectUrl(raw: string): URL | null {
  if (raw.length > 512 || raw.includes("#") || raw !== raw.trim()) return null;
  try {
    const url = new URL(raw);
    if (url.username || url.password) return null;
    if (url.protocol === "https:" || (url.protocol === "http:" && loopback(url))) return url;
  } catch {
    return null;
  }
  return null;
}

function matchesRedirect(raw: string, allowed: string): boolean {
  if (raw === allowed) return true;
  const given = redirectUrl(raw);
  const registered = redirectUrl(allowed);
  // RFC 8252 §7.3, with localhost support for Claude Code:
  // https://claude.com/docs/connectors/building/authentication#callback-urls
  if (!given || !registered || given.protocol !== "http:" || !loopback(given)) return false;
  given.port = "";
  registered.port = "";
  return given.href === registered.href;
}

function matchesResource(raw: string | null, resource: string): boolean {
  if (!raw || raw.includes("#")) return false;
  try {
    return new URL(raw).href === resource;
  } catch {
    return false;
  }
}

interface ClientMetadata {
  client_name: string;
  redirect_uris: string[];
}

function readClient(raw: unknown, defaultName?: string): ClientMetadata | null {
  if (
    !isPlainObject(raw) ||
    !Array.isArray(raw.redirect_uris) ||
    raw.redirect_uris.length === 0 ||
    raw.redirect_uris.length > 8 ||
    !raw.redirect_uris.every((uri) => typeof uri === "string" && redirectUrl(uri) !== null) ||
    (raw.token_endpoint_auth_method !== undefined && raw.token_endpoint_auth_method !== "none")
  ) {
    return null;
  }
  const name = typeof raw.client_name === "string" ? raw.client_name.trim() : defaultName;
  return name && name.length <= 100
    ? { client_name: name, redirect_uris: raw.redirect_uris }
    : null;
}

async function signRegistration(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`solv operator client registration v1\n${value}`),
  );
  return base64url(new Uint8Array(mac));
}

async function register(request: Request, issuer: string, secret: string): Promise<Response> {
  const raw: unknown = await readCapped(request, 8192)
    .then(JSON.parse)
    .catch(() => null);
  if (!isPlainObject(raw)) return oauthError("invalid_client_metadata");
  const metadata = readClient({ token_endpoint_auth_method: "none", ...raw }, "MCP client");
  if (!metadata)
    return oauthError(
      "invalid_client_metadata",
      400,
      "Register a public client with valid callback URLs.",
    );
  const payload = base64url(
    encoder.encode(JSON.stringify({ ...metadata, nonce: crypto.randomUUID() })),
  );
  // RFC7591 registration with an issuer-bound, signed public client ID. No anonymous database writes.
  const clientId = `dcr.${payload}.${await signRegistration(`${issuer}\n${payload}`, secret)}`;
  return privateJson(
    {
      client_id: clientId,
      ...metadata,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    },
    201,
  );
}

async function resolveClient(
  clientId: string,
  issuer: string,
  secret: string,
): Promise<ClientMetadata | null> {
  const match = /^dcr\.([\w-]+)\.([\w-]{43})$/.exec(clientId);
  if (match?.[1] && match[2]) {
    if (!constantTimeEqual(match[2], await signRegistration(`${issuer}\n${match[1]}`, secret)))
      return null;
    const decoded = atob(match[1].replace(/-/g, "+").replace(/_/g, "/"));
    return readClient(
      JSON.parse(new TextDecoder().decode(Uint8Array.from(decoded, (c) => c.charCodeAt(0)))),
    );
  }
  // https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization#client-id-metadata-documents
  // Fetch only for a signed-in operator, apply the outbound URL guard and permit no redirects.
  try {
    const url = assertPublicHttpsUrl(clientId);
    if (url.pathname === "/" || url.hash || url.search) return null;
    const cacheKey = new Request(
      `${issuer}/.well-known/operator-client-cache?id=${encodeURIComponent(clientId)}`,
    );
    // Only verified public metadata is cached. Cache failures cannot block sign-in.
    const cache = await caches.open("solv-operator-client-metadata").catch(() => undefined);
    const cached = await cache?.match(cacheKey).catch(() => undefined);
    if (cached) {
      const metadata = readClient(await cached.json().catch(() => null));
      if (metadata) return metadata;
    }
    const { body, response } = await fetchCapped(url, fetch, {
      maxRedirects: 0,
      timeoutMs: 5000,
      maxBytes: 8192,
      accept: "application/json",
    });
    const raw: unknown = JSON.parse(body);
    const metadata = isPlainObject(raw) && raw.client_id === clientId ? readClient(raw) : null;
    const policy = response.headers.get("cache-control") ?? "";
    const directives = policy.split(",").map((part) => part.trim().toLowerCase());
    const seconds = (name: string) =>
      Number(directives.find((part) => part.startsWith(`${name}=`))?.split("=")[1]);
    const sharedAge = seconds("s-maxage");
    const maxAge = Number.isNaN(sharedAge) ? seconds("max-age") : sharedAge;
    const ttl = Math.min(3600, maxAge - Number(response.headers.get("age") ?? 0));
    if (
      metadata &&
      ttl > 0 &&
      !directives.some((part) => /^(private|no-store|no-cache)(=|$)/.test(part))
    ) {
      await cache
        ?.put(
          cacheKey,
          Response.json(metadata, {
            headers: { "cache-control": `public, max-age=${ttl}` },
          }),
        )
        .catch(() => {});
    }
    return metadata;
  } catch {
    return null;
  }
}

const authorizationFields = [
  "response_type",
  "client_id",
  "redirect_uri",
  "scope",
  "state",
  "code_challenge",
  "code_challenge_method",
  "resource",
] as const;

function callback(url: URL, state: string | null, name: string, value: string): Response {
  if (state !== null) url.searchParams.set("state", state);
  url.searchParams.set(name, value);
  return new Response(null, {
    status: 303,
    headers: { location: url.href, "cache-control": "no-store", "referrer-policy": "no-referrer" },
  });
}

export function selfHostedOperatorAuth(
  db: D1Database,
  orgId: string,
  userId: string,
  admin: Pick<AuthProvider, "authenticate" | "login">,
  secret: string | undefined,
): OperatorAuth {
  const credentials = operatorCredentials(db, orgId, userId);
  return {
    ...credentials,
    metadataUrl: (resource) => `${new URL(resource).origin}${PROTECTED}/mcp`,
    async handle(request) {
      const url = new URL(request.url);
      const issuer = url.origin;
      const resource = `${issuer}/mcp`;
      // https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization#authorization-server-discovery
      if (
        request.method === "GET" &&
        (url.pathname === `${PROTECTED}/mcp` || url.pathname === PROTECTED)
      ) {
        return Response.json({
          resource,
          authorization_servers: [issuer],
          scopes_supported: OPERATOR_SCOPES,
          bearer_methods_supported: ["header"],
        });
      }
      if (request.method === "GET" && url.pathname === METADATA) {
        return Response.json({
          issuer,
          authorization_endpoint: issuer + AUTHORIZE,
          token_endpoint: issuer + TOKEN,
          registration_endpoint: issuer + REGISTER,
          revocation_endpoint: issuer + REVOKE,
          client_id_metadata_document_supported: true,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          token_endpoint_auth_methods_supported: ["none"],
          revocation_endpoint_auth_methods_supported: ["none"],
          code_challenge_methods_supported: ["S256"],
          scopes_supported: OPERATOR_SCOPES,
        });
      }
      if (url.pathname === AUTHORIZE && (request.method === "GET" || request.method === "POST")) {
        if (!secret)
          return oauthPage({ kind: "error", message: "Set up admin sign-in first." }, 503);
        if (request.method === "POST" && request.headers.get("origin") !== issuer) {
          return oauthPage(
            { kind: "error", message: "Open the connection again from your MCP client." },
            403,
          );
        }
        const data = request.method === "GET" ? url.searchParams : await form(request);
        const invalid = () =>
          oauthPage(
            {
              kind: "error",
              message: "Check the client’s OAuth settings and start the connection again.",
            },
            400,
          );
        if (!data || authorizationFields.some((field) => data.getAll(field).length > 1))
          return invalid();
        const query = new URLSearchParams();
        for (const field of authorizationFields) {
          const value = data.get(field);
          if (value !== null) query.set(field, value);
        }
        const clientId = query.get("client_id") ?? "";
        const rawRedirect = query.get("redirect_uri") ?? "";
        const redirect = redirectUrl(rawRedirect);
        const challenge = query.get("code_challenge") ?? "";
        const requested = (query.get("scope") ?? "read").split(/ +/);
        const scopes = OPERATOR_SCOPES.filter((scope) => requested.includes(scope));
        if (
          !clientId ||
          clientId.length > 7000 ||
          !redirect ||
          !/^[\w-]{43}$/.test(challenge) ||
          query.get("code_challenge_method") !== "S256" ||
          query.get("response_type") !== "code" ||
          !matchesResource(query.get("resource"), resource) ||
          (query.get("state")?.length ?? 0) > 1024 ||
          requested.some((scope) => scope !== "read" && scope !== "full")
        )
          return invalid();

        const principal = await admin.authenticate(request);
        const decision = one(data, "decision");
        if (!principal) {
          if (request.method === "GET") return oauthPage({ kind: "login", query });
          if (decision !== "sign-in") return oauthPage({ kind: "login", query }, 401);
          const login = await admin.login(
            new Request(`${issuer}/api/admin/login`, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "cf-connecting-ip": request.headers.get("cf-connecting-ip") ?? "unknown",
              },
              body: JSON.stringify({ password: one(data, "password") }),
            }),
          );
          if (!login.ok) {
            const body = await login.json<{ error: string }>();
            return oauthPage({ kind: "login", query, error: body.error }, login.status, {
              ...(login.headers.has("retry-after")
                ? { "retry-after": login.headers.get("retry-after") ?? "" }
                : {}),
            });
          }
          const headers = new Headers({
            location: `${AUTHORIZE}?${query}`,
            "cache-control": "no-store",
            "referrer-policy": "no-referrer",
          });
          const cookie = login.headers.get("set-cookie");
          if (cookie) headers.set("set-cookie", cookie);
          return new Response(null, { status: 303, headers });
        }

        if (principal.orgId !== orgId || principal.userId !== userId) return invalid();
        const client = await resolveClient(clientId, issuer, secret);
        if (!client?.redirect_uris.some((uri) => matchesRedirect(rawRedirect, uri)))
          return invalid();
        if (request.method === "GET") {
          return oauthPage(
            {
              kind: "consent",
              query,
              name: client.client_name,
              scopes,
              callbackHost: redirect.host,
              localOnly: client.redirect_uris.every((uri) => loopback(new URL(uri))),
            },
            200,
            undefined,
            redirect.origin,
          );
        }
        const state = query.get("state");
        if (decision === "deny") return callback(redirect, state, "error", "access_denied");
        const scope = one(data, "access") as OperatorScope | null;
        if (decision !== "allow" || !scope || !scopes.includes(scope)) return invalid();
        const code = randomCredential("solv_code_");
        const now = Date.now();
        await db.batch([
          db
            .prepare("DELETE FROM operator_grants WHERE org_id = ? AND expires_at <= ?")
            .bind(orgId, now),
          db
            .prepare(`
            INSERT INTO operator_grants (org_id, id, user_id, name, scope, resource, client_id,
              redirect_uri, challenge, code_hash, expires_at, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `)
            .bind(
              orgId,
              crypto.randomUUID(),
              userId,
              client.client_name,
              scope,
              resource,
              clientId,
              rawRedirect,
              challenge,
              await sha256Hex(code),
              now + CODE_TTL,
              now,
            ),
        ]);
        return callback(redirect, state, "code", code);
      }

      if (request.method !== "POST") return null;
      if (url.pathname === REGISTER)
        return secret
          ? register(request, issuer, secret)
          : oauthError("temporarily_unavailable", 503);
      if (url.pathname !== TOKEN && url.pathname !== REVOKE) return null;
      const data = await form(request);
      const clientId = data && one(data, "client_id");
      if (
        !data ||
        !clientId ||
        clientId.length > 7000 ||
        data.has("client_secret") ||
        data.has("client_assertion") ||
        request.headers.has("authorization")
      )
        return oauthError("invalid_client");

      if (url.pathname === REVOKE) {
        // RFC7009: revoking either current token revokes the connection and its delegated tokens.
        const value = one(data, "token");
        if (!value) return oauthError("invalid_request");
        const hash = await sha256Hex(value);
        await db
          .prepare(`
          DELETE FROM operator_grants WHERE org_id = ?1 AND user_id = ?2 AND client_id = ?3 AND resource = ?4
            AND (access_hash = ?5 OR refresh_hash = ?5)
        `)
          .bind(orgId, userId, clientId, resource, hash)
          .run();
        return privateJson({});
      }

      // https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization#resource-parameter-implementation
      if (!matchesResource(one(data, "resource"), resource)) return oauthError("invalid_target");
      const grantType = one(data, "grant_type");
      const access = randomCredential("solv_access_");
      const refresh = randomCredential("solv_refresh_");
      const now = Date.now();
      const accessHash = await sha256Hex(access);
      const refreshHash = await sha256Hex(refresh);
      type IssuedGrant = { scope: OperatorScope; accessExpiresAt: number };
      let grant: IssuedGrant | null;
      if (grantType === "authorization_code") {
        const code = one(data, "code");
        const verifier = one(data, "code_verifier");
        const redirect = one(data, "redirect_uri");
        if (!code || !verifier || !PKCE.test(verifier) || !redirect)
          return oauthError("invalid_grant");
        const challenge = base64url(
          new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(verifier))),
        );
        grant = await db
          .prepare(`
          UPDATE operator_grants SET code_hash = NULL, challenge = NULL, access_hash = ?1,
            refresh_hash = ?2, access_expires_at = ?3, expires_at = ?4
          WHERE org_id = ?5 AND user_id = ?6 AND resource = ?7 AND client_id = ?8 AND expires_at > ?9
            AND redirect_uri = ?10 AND challenge = ?11 AND code_hash = ?12 RETURNING scope, access_expires_at AS accessExpiresAt
        `)
          .bind(
            accessHash,
            refreshHash,
            now + ACCESS_TTL_SECONDS * 1000,
            now + GRANT_TTL,
            orgId,
            userId,
            resource,
            clientId,
            now,
            redirect,
            challenge,
            await sha256Hex(code),
          )
          .first();
      } else if (grantType === "refresh_token") {
        const value = one(data, "refresh_token");
        if (!value) return oauthError("invalid_grant");
        const requested = one(data, "scope");
        if (data.has("scope") && requested !== "read" && requested !== "full")
          return oauthError("invalid_scope");
        const hash = await sha256Hex(value);
        // RFC9700 §4.14.2: rotate refresh tokens atomically and revoke the grant on reuse.
        const [_, rotated] = await db.batch<IssuedGrant>([
          db
            .prepare(`
            DELETE FROM operator_grants WHERE org_id = ?1 AND user_id = ?2 AND resource = ?3 AND client_id = ?4
              AND id IN (SELECT grant_id FROM operator_spent_refresh WHERE org_id = ?1 AND hash = ?5)
          `)
            .bind(orgId, userId, resource, clientId, hash),
          db
            .prepare(`
            UPDATE operator_grants SET access_hash = ?1, refresh_hash = ?2, access_expires_at = MIN(?3, expires_at)
            WHERE org_id = ?4 AND user_id = ?5 AND resource = ?6 AND client_id = ?7 AND expires_at > ?8
              AND refresh_hash = ?9 AND (?10 IS NULL OR scope = ?10) RETURNING scope, access_expires_at AS accessExpiresAt
          `)
            .bind(
              accessHash,
              refreshHash,
              now + ACCESS_TTL_SECONDS * 1000,
              orgId,
              userId,
              resource,
              clientId,
              now,
              hash,
              requested,
            ),
        ]);
        grant = rotated?.results[0] ?? null;
      } else {
        return oauthError("unsupported_grant_type");
      }
      return grant
        ? privateJson({
            access_token: access,
            token_type: "Bearer",
            expires_in: Math.ceil((grant.accessExpiresAt - now) / 1000),
            refresh_token: refresh,
            scope: grant.scope,
          })
        : oauthError("invalid_grant");
    },
  };
}
