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
      void ctx; // Later tasks add their routes above this line.
      return Response.json({ error: "Not found." }, { status: 404 });
    },
    async queue(batch, env, ctx) {
      // The ingest task fills this in. Explicitly retry every message so
      // nothing is acknowledged and discarded while the consumer is unbuilt.
      void env;
      void ctx;
      batch.retryAll();
    },
  };
}
