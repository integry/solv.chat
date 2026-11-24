import { isPlainObject, parseVersionConfig } from "@solvchat/core";
import { type RunDeps, replaceTests, runAnswerTests } from "../admin/answerTests.js";
import { BadRequest, Conflict, NotFound, readJsonBody } from "../admin/errors.js";
import { applyMcpServerSettings, listMcpServerSettings } from "../admin/mcp.js";
import { getDraft, updateDraft } from "../admin/versions.js";
import { forIngestScope, type IngestScope, type Tenant } from "../db/tenant.js";
import type { Retriever } from "../providers/retrieval.js";
import type { AuthProvider, Limits } from "../seams/types.js";
import { ingestScopeFor } from "./auth.js";
import { deleteDocuments, type IngestQueueMessage, pushDocuments, TooLarge } from "./documents.js";
import type { RepeatedQueue } from "./repeatedSource.js";

export type IngestResource = "documents" | "config" | "tests" | "test-runs" | "mcp-servers";

export interface IngestRouteDeps {
  db: D1Database;
  docs: R2Bucket;
  queue: Queue<IngestQueueMessage>;
  retriever: Pick<Retriever, "remove">;
  limits: Limits;
  auth: Pick<AuthProvider, "resolveOrg">;
  resolveRunDeps: (orgId: string, tenant: Tenant) => Promise<RunDeps>;
}

/** Handles `/v1/ingest/:assistantId/{documents,config,tests,test-runs,mcp-servers}`. */
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
  } else if (resource === "config" || resource === "tests" || resource === "mcp-servers") {
    if (request.method !== "GET" && request.method !== "PUT") {
      return Response.json({ error: "Not found." }, { status: 404 });
    }
  } else if (request.method !== "POST") {
    return Response.json({ error: "Not found." }, { status: 404 });
  }

  const scope = await ingestScopeFor(deps.db, deps.auth, request, assistantId);
  if (scope === null) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }

  return scopedIngestRoutes(request, scope, resource, deps);
}

export function validateIngestDraft(
  body: unknown,
  current?: Awaited<ReturnType<typeof getDraft>>["config"],
) {
  const parsed = parseVersionConfig(body, current);
  if (!parsed.ok) throw new BadRequest(parsed.errors);
  rejectPageToolServers(body);
}

function rejectPageToolServers(body: unknown) {
  if (isPlainObject(body) && body.pageToolServers !== undefined) {
    throw new BadRequest(["pageToolServers: change where keys come from on the Tools screen"]);
  }
}

export async function scopedIngestRoutes(
  request: Request,
  scope: IngestScope,
  resource: IngestResource,
  deps: Omit<IngestRouteDeps, "auth">,
): Promise<Response> {
  const limit = await deps.limits.check(scope.orgId, scope.assistantId, { kind: "ingest" });
  if (!limit.ok) {
    return Response.json({ error: "Ingest limit exceeded." }, { status: 429 });
  }

  const tenant = forIngestScope(deps.db, scope);

  try {
    if (resource === "config") {
      if (request.method === "GET") {
        const draft = await getDraft(tenant, scope.assistantId);
        const { pageToolServers: _pageToolServers, ...config } = draft.config;
        return Response.json({ config });
      }
      const body = await readJsonBody(request);
      rejectPageToolServers(body);
      const draft = await updateDraft(tenant, scope.assistantId, body);
      const { pageToolServers: _pageToolServers, ...config } = draft.config;
      return Response.json({ config });
    }

    if (resource === "tests") {
      if (request.method === "GET") {
        return Response.json({ tests: await tenant.tests.list(scope.assistantId) });
      }
      // Replace, not merge: the file is a full declaration. Merging by
      // question text would resurrect a test the owner deleted in the admin,
      // with nothing to explain why it came back.
      const result = await replaceTests(tenant, scope.assistantId, await readJsonBody(request));
      return Response.json(result);
    }

    if (resource === "mcp-servers") {
      // Only the "Send conversation context" setting, and only turning it
      // off: an ingest key can neither add a server, read its full address or
      // credential, nor start sharing visitor ids with a server.
      if (request.method === "GET") {
        return Response.json(await listMcpServerSettings(tenant, scope.assistantId));
      }
      return Response.json(
        await applyMcpServerSettings(tenant, scope.assistantId, await readJsonBody(request)),
      );
    }

    if (resource === "test-runs") {
      // The same runner the admin's "Run now" uses, so CI and the screen
      // cannot disagree about whether a draft passes.
      const { draft: _draft, ...run } = await runAnswerTests(
        await deps.resolveRunDeps(scope.orgId, tenant),
        scope.assistantId,
      );
      return Response.json(run);
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
      {
        tenant,
        docs: deps.docs,
        retriever: deps.retriever,
        // The same queue carries a source's `repeated_source` message.
        repeated: { queue: deps.queue as unknown as RepeatedQueue, orgId: scope.orgId },
      },
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
