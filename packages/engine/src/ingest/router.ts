import { BadRequest, Conflict, NotFound, readJsonBody } from "../admin/errors.js";
import { getDraft, updateDraft } from "../admin/versions.js";
import { forIngestScope } from "../db/tenant.js";
import type { Retriever } from "../providers/retrieval.js";
import type { AuthProvider, Limits } from "../seams/types.js";
import { ingestScopeFor } from "./auth.js";
import { deleteDocuments, type IngestQueueMessage, pushDocuments, TooLarge } from "./documents.js";

export type IngestResource = "documents" | "config";

export interface IngestRouteDeps {
  db: D1Database;
  docs: R2Bucket;
  queue: Queue<IngestQueueMessage>;
  retriever: Pick<Retriever, "remove">;
  limits: Limits;
  auth: Pick<AuthProvider, "resolveOrg">;
}

/** Handles `/v1/ingest/:assistantId/documents` and `/v1/ingest/:assistantId/config`. */
export async function ingestRoutes(
  request: Request,
  assistantId: string,
  resource: IngestResource,
  deps: IngestRouteDeps,
): Promise<Response> {
  if (resource === "documents") {
    if (request.method !== "PUT" && request.method !== "DELETE") {
      return Response.json({ error: "Not found." }, { status: 404 });
    }
  } else if (request.method !== "GET" && request.method !== "PUT") {
    return Response.json({ error: "Not found." }, { status: 404 });
  }

  const scope = await ingestScopeFor(deps.db, deps.auth, request, assistantId);
  if (scope === null) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }

  const limit = await deps.limits.check(scope.orgId, scope.assistantId, { kind: "ingest" });
  if (!limit.ok) {
    return Response.json({ error: "Ingest limit exceeded." }, { status: 429 });
  }

  const tenant = forIngestScope(deps.db, scope);

  try {
    if (resource === "config") {
      if (request.method === "GET") {
        const draft = await getDraft(tenant, scope.assistantId);
        return Response.json({ config: draft.config });
      }
      const body = await readJsonBody(request);
      const draft = await updateDraft(tenant, scope.assistantId, body);
      return Response.json({ config: draft.config });
    }

    const body = await readJsonBody(request);
    // An ingest key only ever writes pushed content; entries and sitemap
    // imports are the owner's, edited in the admin.
    const pushOnly = { requireKind: "push" } as const;
    if (request.method === "PUT") {
      const result = await pushDocuments(
        { tenant, docs: deps.docs, queue: deps.queue },
        scope,
        body,
        pushOnly,
      );
      return Response.json(result);
    }

    const result = await deleteDocuments(
      { tenant, docs: deps.docs, retriever: deps.retriever },
      scope,
      body,
      pushOnly,
    );
    return Response.json(result);
  } catch (err) {
    if (err instanceof TooLarge) {
      return Response.json({ error: err.message }, { status: 413 });
    }
    if (err instanceof BadRequest) {
      return Response.json({ error: err.message, errors: err.errors }, { status: 400 });
    }
    if (err instanceof Conflict) {
      return Response.json({ error: err.message || "Please try again." }, { status: 409 });
    }
    if (err instanceof NotFound) {
      return Response.json({ error: "Not found." }, { status: 404 });
    }
    throw err;
  }
}
