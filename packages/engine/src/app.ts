import { adminAsset } from "./admin/assets.js";
import { adminRoutes } from "./admin/router.js";
import {
  adminChatRoute,
  type ChatRouteOverrides,
  chatRoute,
  feedbackRoute,
  publicConfigRoute,
  resolveChatProviders,
} from "./chat/route.js";
import { forPrincipal } from "./db/tenant.js";
import { runIngestBatch } from "./ingest/consumer.js";
import { ingestRoutes } from "./ingest/router.js";
import {
  checkLlmConfigError,
  embedderFor,
  type ProviderEnv,
  resolveProviderSettings,
} from "./providers/config.js";
import { vectorizeRetriever } from "./providers/retrieval.js";
import type { Seams } from "./seams/types.js";
import { WIDGET_BUNDLE } from "./widgetBundle.js";

/**
 * Decodes one path segment, or returns null when the percent-encoding is
 * malformed (`%E0%A4%A`), so the route can answer 404 instead of throwing.
 */
function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

const notFound = (): Response => Response.json({ error: "Not found." }, { status: 404 });

function widgetAsset(): Response {
  return new Response(WIDGET_BUNDLE, {
    status: 200,
    headers: {
      "content-type": "application/javascript; charset=utf-8",
      "cache-control": "public, max-age=86400",
    },
  });
}

export interface Env extends ProviderEnv {
  DB: D1Database;
  VECTORS: VectorizeIndex;
  DOCS: R2Bucket;
  INGEST_QUEUE: Queue;
  SOLV_SECRET_KEY?: string | undefined;
  SOLV_ANTHROPIC_KEY?: string | undefined;
  SOLV_OPENAI_KEY?: string | undefined;
  SOLV_OPENROUTER_KEY?: string | undefined;
}

export interface App {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response>;
  queue(batch: MessageBatch<unknown>, env: Env, ctx: ExecutionContext): Promise<void>;
}

export interface AppOptions {
  chat?: ChatRouteOverrides | undefined;
  fetch?: typeof fetch | undefined;
}

/** Creates the Worker fetch and queue handlers wired to the given extension seams. */
export function createApp(seams: Seams, options?: AppOptions): App {
  const chatOverrides: ChatRouteOverrides | undefined =
    options?.fetch && !options.chat?.fetch
      ? { ...options.chat, fetch: options.fetch }
      : options?.chat;

  return {
    async fetch(request, env, ctx) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health") {
        // One query: a Worker answering 200 with a missing D1 binding is worse
        // than one that fails, because deploys look healthy.
        await env.DB.prepare("SELECT 1").first();
        return Response.json({ ok: true });
      }
      if (url.pathname === "/v1/chat") {
        return chatRoute(request, env, seams, ctx, chatOverrides);
      }
      if (url.pathname === "/v1/feedback") {
        return feedbackRoute(request, env, seams);
      }
      const publicConfigMatch = /^\/v1\/assistants\/([^/]+)$/.exec(url.pathname);
      if (publicConfigMatch?.[1]) {
        const publicKey = decodeSegment(publicConfigMatch[1]);
        if (publicKey === null) return notFound();
        return publicConfigRoute(request, env, seams, publicKey);
      }
      if (request.method === "GET" && url.pathname === "/widget.js") {
        // Long cache: the owner embeds a stable URL, so a long max-age keeps
        // the script tag from costing a round trip on every page view. Forward
        // compatibility is handled by the protocol version rather than by
        // making owners bust a cache.
        return widgetAsset();
      }
      const ingestMatch = /^\/v1\/ingest\/([^/]+)\/(documents|config)$/.exec(url.pathname);
      if (ingestMatch?.[1] && ingestMatch[2]) {
        const assistantId = decodeSegment(ingestMatch[1]);
        if (assistantId === null) return notFound();
        return ingestRoutes(request, assistantId, ingestMatch[2] as "documents" | "config", {
          db: env.DB,
          docs: env.DOCS,
          queue: env.INGEST_QUEUE,
          retriever: vectorizeRetriever(env.VECTORS),
          limits: seams.limits,
          auth: seams.auth,
        });
      }
      if (url.pathname === "/api/admin" || url.pathname.startsWith("/api/admin/")) {
        if (request.method !== "GET" && request.method !== "HEAD") {
          const origin = request.headers.get("origin");
          if (origin !== url.origin) {
            return Response.json({ error: "Forbidden." }, { status: 403 });
          }
        }
      }
      if (request.method === "POST" && url.pathname === "/api/admin/login") {
        return seams.auth.login(request);
      }
      if (request.method === "POST" && url.pathname === "/api/admin/logout") {
        return seams.auth.logout(request);
      }
      // One gate for the whole admin surface: resolve the principal here and
      // hand down a Tenant, so no handler can read a row without the filter.
      if (url.pathname === "/api/admin" || url.pathname.startsWith("/api/admin/")) {
        const principal = await seams.auth.authenticate(request);
        if (principal === null) return Response.json({ error: "Sign in first." }, { status: 401 });
        if (url.pathname === "/api/admin/chat") {
          return adminChatRoute(request, env, seams, ctx, principal, chatOverrides);
        }
        const tenant = forPrincipal(env.DB, principal);
        return adminRoutes(request, url, {
          tenant,
          orgId: principal.orgId,
          docs: env.DOCS,
          queue: env.INGEST_QUEUE,
          retriever: vectorizeRetriever(env.VECTORS),
          publicBaseUrl: url.origin,
          fetchImpl: options?.fetch,
          // Used only to seal and open stored MCP credentials and provider keys.
          secretKey: env.SOLV_SECRET_KEY ?? "",
          keys: seams.keys,
          envSecretPresence: {
            anthropic: Boolean(env.SOLV_ANTHROPIC_KEY),
            openai: Boolean(env.SOLV_OPENAI_KEY),
            openrouter: Boolean(env.SOLV_OPENROUTER_KEY),
          },
          resolveSettings: () => resolveProviderSettings(env.DB, env, principal.orgId),
          checkConfigError: (resolved) =>
            checkLlmConfigError(env.DB, env, seams.keys, principal.orgId, resolved),
          resolveRunDeps: async () => {
            const providers = await resolveChatProviders(
              env,
              seams,
              principal.orgId,
              chatOverrides,
            );
            return {
              tenant,
              orgId: principal.orgId,
              ...providers,
              usage: seams.usage,
              limits: seams.limits,
              secretKey: env.SOLV_SECRET_KEY ?? "",
              fetchImpl: chatOverrides?.fetch,
            };
          },
        });
      }
      if (
        (request.method === "GET" || request.method === "HEAD") &&
        (url.pathname === "/admin" || url.pathname.startsWith("/admin/"))
      ) {
        return adminAsset(url);
      }
      void ctx; // Later tasks add their routes above this line.
      return notFound();
    },
    async queue(batch, env, ctx) {
      void ctx;
      const byOrg = new Map<string, Message<unknown>[]>();
      for (const message of batch.messages) {
        const body = message.body as { orgId?: unknown } | null;
        if (typeof body?.orgId !== "string" || body.orgId === "") {
          message.ack();
          continue;
        }
        const list = byOrg.get(body.orgId);
        if (list) {
          list.push(message);
        } else {
          byOrg.set(body.orgId, [message]);
        }
      }

      const retriever = vectorizeRetriever(env.VECTORS);
      const resolveOrg = (orgId: string) => seams.auth.resolveOrg({ kind: "queued_ingest", orgId });
      for (const [claimedOrgId, messages] of byOrg) {
        // The message's org is a claim until the auth seam vouches for it:
        // no key is fetched and nothing is read for an org it refuses.
        const orgId = await resolveOrg(claimedOrgId);
        if (orgId === null) {
          for (const message of messages) message.ack();
          continue;
        }
        const settings = await resolveProviderSettings(env.DB, env, orgId);
        const embedder = await embedderFor(
          orgId,
          settings.embeddingsProvider.value,
          seams.keys,
          options?.fetch,
        );
        await runIngestBatch(
          { messages },
          {
            db: env.DB,
            docs: env.DOCS,
            embedder,
            retriever,
            usage: seams.usage,
            resolveOrg,
          },
        );
      }
    },
  };
}
