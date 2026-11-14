import type { Tenant } from "../db/tenant.js";
import { type IngestQueueMessage, TooLarge } from "../ingest/documents.js";
import {
  createAssistant,
  getAssistant,
  listAssistants,
  rotateIngestKey,
  updateAssistant,
} from "./assistants.js";
import { saveEntry } from "./entries.js";
import { BadRequest, Conflict, NotFound, readJsonBody } from "./errors.js";
import { importSitemapUrls, previewSitemap } from "./sitemap.js";
import {
  createSource,
  deleteSource,
  getSourceDocument,
  listSourceDocuments,
  listSources,
  updateSource,
} from "./sources.js";
import { getDraft, listVersions, publishDraft, rollbackTo, updateDraft } from "./versions.js";

export interface AdminRouteDeps {
  tenant: Tenant;
  orgId: string;
  docs: Pick<R2Bucket, "get" | "put" | "delete">;
  queue: { send(message: IngestQueueMessage): Promise<unknown> };
  publicBaseUrl: string;
  fetchImpl?: typeof fetch | undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readEntryFields(body: unknown): { question: string; answer: string } {
  if (!isPlainObject(body)) {
    throw new BadRequest(["body: must be a JSON object"]);
  }
  return {
    question: typeof body.question === "string" ? body.question : "",
    answer: typeof body.answer === "string" ? body.answer : "",
  };
}

async function assistantRoutes(
  request: Request,
  url: URL,
  segments: string[],
  deps: AdminRouteDeps,
): Promise<Response> {
  const { tenant } = deps;
  const method = request.method;

  if (segments.length === 1) {
    if (method === "GET") {
      return Response.json({ assistants: await listAssistants(tenant) });
    }
    if (method === "POST") {
      const result = await createAssistant(tenant, await readJsonBody(request));
      return Response.json(result, { status: 201 });
    }
    throw new NotFound();
  }

  const assistantId = segments[1];
  if (!assistantId) throw new NotFound();

  if (segments.length === 2) {
    if (method === "GET") {
      return Response.json({ assistant: await getAssistant(tenant, assistantId) });
    }
    if (method === "PATCH") {
      const assistant = await updateAssistant(tenant, assistantId, await readJsonBody(request));
      return Response.json({ assistant });
    }
    throw new NotFound();
  }

  if (segments.length === 3) {
    const action = segments[2];
    if (action === "ingest-key" && method === "POST") {
      return Response.json({ ingestKey: await rotateIngestKey(tenant, assistantId) });
    }
    if (action === "versions" && method === "GET") {
      return Response.json({ versions: await listVersions(tenant, assistantId) });
    }
    if (action === "draft" && method === "GET") {
      return Response.json({ draft: await getDraft(tenant, assistantId) });
    }
    if (action === "draft" && method === "PUT") {
      const draft = await updateDraft(tenant, assistantId, await readJsonBody(request));
      return Response.json({ draft });
    }
    if (action === "publish" && method === "POST") {
      return Response.json({ version: await publishDraft(tenant, assistantId) });
    }
    if (action === "sources" && method === "GET") {
      return Response.json({ sources: await listSources(tenant, assistantId) });
    }
    if (action === "sources" && method === "POST") {
      const source = await createSource(tenant, assistantId, await readJsonBody(request));
      return Response.json({ source }, { status: 201 });
    }
    if (action === "entries" && method === "POST") {
      const fields = readEntryFields(await readJsonBody(request));
      const result = await saveEntry(
        { tenant, docs: deps.docs, queue: deps.queue, publicBaseUrl: deps.publicBaseUrl },
        { orgId: deps.orgId },
        { assistantId, ...fields },
      );
      return Response.json(result, { status: 201 });
    }
    if (action === "sitemap-preview" && method === "POST") {
      const assistant = await tenant.assistants.get(assistantId);
      if (assistant === null) throw new NotFound("assistant");
      const body = await readJsonBody(request);
      if (!isPlainObject(body) || typeof body.url !== "string") {
        throw new BadRequest(["url: must be a string"]);
      }
      const urls = await previewSitemap(body.url, deps.fetchImpl);
      return Response.json({ urls });
    }
    if (action === "sitemap-import" && method === "POST") {
      const body = await readJsonBody(request);
      if (!isPlainObject(body)) {
        throw new BadRequest(["body: must be a JSON object"]);
      }
      const result = await importSitemapUrls(
        { tenant, docs: deps.docs, queue: deps.queue },
        { orgId: deps.orgId, assistantId },
        {
          ...(typeof body.sitemapUrl === "string" ? { sitemapUrl: body.sitemapUrl } : {}),
          ...(typeof body.label === "string" ? { label: body.label } : {}),
          ...(typeof body.sourceId === "string" ? { sourceId: body.sourceId } : {}),
          urls: Array.isArray(body.urls) ? (body.urls as string[]) : [],
        },
        deps.fetchImpl,
      );
      return Response.json(result, { status: 201 });
    }
    void url;
    throw new NotFound();
  }

  if (
    segments.length === 5 &&
    segments[2] === "versions" &&
    segments[3] &&
    segments[4] === "rollback" &&
    method === "POST"
  ) {
    const version = await rollbackTo(tenant, assistantId, segments[3]);
    return Response.json({ version });
  }

  throw new NotFound();
}

async function sourceRoutes(
  request: Request,
  url: URL,
  segments: string[],
  deps: AdminRouteDeps,
): Promise<Response> {
  const { tenant } = deps;
  const method = request.method;
  const sourceId = segments[1];
  if (!sourceId) throw new NotFound();

  if (segments.length === 2) {
    if (method === "PATCH") {
      const source = await updateSource(tenant, sourceId, await readJsonBody(request));
      return Response.json({ source });
    }
    if (method === "DELETE") {
      return Response.json(await deleteSource(tenant, sourceId));
    }
    throw new NotFound();
  }

  if (segments.length === 3) {
    const sub = segments[2];
    if (sub === "documents" && method === "GET") {
      const rawLimit = url.searchParams.get("limit");
      const rawOffset = url.searchParams.get("offset");
      const limit = rawLimit !== null ? Number(rawLimit) : undefined;
      const offset = rawOffset !== null ? Number(rawOffset) : undefined;
      return Response.json(
        await listSourceDocuments(tenant, sourceId, {
          ...(limit !== undefined && Number.isFinite(limit) ? { limit } : {}),
          ...(offset !== undefined && Number.isFinite(offset) ? { offset } : {}),
        }),
      );
    }
    if (sub === "entries" && method === "POST") {
      const source = await tenant.sources.get(sourceId);
      if (source === null) throw new NotFound("source");
      const fields = readEntryFields(await readJsonBody(request));
      const result = await saveEntry(
        { tenant, docs: deps.docs, queue: deps.queue, publicBaseUrl: deps.publicBaseUrl },
        { orgId: deps.orgId },
        { assistantId: source.assistantId, sourceId, ...fields },
      );
      return Response.json(result, { status: 201 });
    }
    throw new NotFound();
  }

  if (segments.length === 4) {
    const sub = segments[2];
    const docId = segments[3];
    if (!docId) throw new NotFound();

    if (sub === "documents" && method === "GET") {
      return Response.json(await getSourceDocument(tenant, deps.docs, sourceId, docId));
    }
    if (sub === "entries" && method === "PUT") {
      const source = await tenant.sources.get(sourceId);
      if (source === null) throw new NotFound("source");
      const fields = readEntryFields(await readJsonBody(request));
      const result = await saveEntry(
        { tenant, docs: deps.docs, queue: deps.queue, publicBaseUrl: deps.publicBaseUrl },
        { orgId: deps.orgId },
        { assistantId: source.assistantId, sourceId, documentId: docId, ...fields },
      );
      return Response.json(result);
    }
  }

  throw new NotFound();
}

/** Dispatches authenticated `/api/admin/*` requests with a tenant-scoped handle. */
export async function adminRoutes(
  request: Request,
  url: URL,
  deps: AdminRouteDeps,
): Promise<Response> {
  const segments = url.pathname.replace(/^\/api\/admin\//, "").split("/");
  try {
    if (segments[0] === "assistants") return await assistantRoutes(request, url, segments, deps);
    if (segments[0] === "sources") return await sourceRoutes(request, url, segments, deps);
    return Response.json({ error: "Not found." }, { status: 404 });
  } catch (error) {
    // Mapped here, once: a handler building its own responses would eventually
    // leak an internal message into an owner's screen.
    if (error instanceof NotFound) return Response.json({ error: "Not found." }, { status: 404 });
    if (error instanceof BadRequest) {
      return Response.json({ error: "That is not valid.", fields: error.errors }, { status: 400 });
    }
    if (error instanceof TooLarge) {
      return Response.json({ error: error.message }, { status: 413 });
    }
    if (error instanceof Conflict) {
      return Response.json({ error: error.message || "Please try again." }, { status: 409 });
    }
    throw error;
  }
}
