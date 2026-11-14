import { adminRoutes } from "./admin/router.js";
import { forPrincipal } from "./db/tenant.js";
import { runIngestBatch } from "./ingest/consumer.js";
import { ingestRoutes } from "./ingest/router.js";
import { openAIEmbedder, vectorizeRetriever } from "./providers/retrieval.js";
import type { Seams } from "./seams/types.js";

export interface Env {
  DB: D1Database;
  VECTORS: VectorizeIndex;
  DOCS: R2Bucket;
  INGEST_QUEUE: Queue;
}

export interface App {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response>;
  queue(batch: MessageBatch<unknown>, env: Env, ctx: ExecutionContext): Promise<void>;
}

/** Creates the Worker fetch and queue handlers wired to the given extension seams. */
export function createApp(seams: Seams): App {
  return {
    async fetch(request, env, ctx) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health") {
        // One query: a Worker answering 200 with a missing D1 binding is worse
        // than one that fails, because deploys look healthy.
        await env.DB.prepare("SELECT 1").first();
        return Response.json({ ok: true });
      }
      const ingestMatch = /^\/v1\/ingest\/([^/]+)\/documents$/.exec(url.pathname);
      if (ingestMatch?.[1]) {
        return ingestRoutes(request, decodeURIComponent(ingestMatch[1]), {
          db: env.DB,
          docs: env.DOCS,
          queue: env.INGEST_QUEUE,
          retriever: vectorizeRetriever(env.VECTORS),
          limits: seams.limits,
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
        return adminRoutes(request, url, forPrincipal(env.DB, principal));
      }
      void ctx; // Later tasks add their routes above this line.
      return Response.json({ error: "Not found." }, { status: 404 });
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
      for (const [orgId, messages] of byOrg) {
        const apiKey = await seams.keys.embeddingKey(orgId);
        await runIngestBatch(
          { messages },
          {
            db: env.DB,
            docs: env.DOCS,
            embedder: openAIEmbedder({ apiKey }),
            retriever,
          },
        );
      }
    },
  };
}
