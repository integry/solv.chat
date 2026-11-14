import type { Tenant } from "../db/tenant.js";
import {
  createAssistant,
  getAssistant,
  listAssistants,
  rotateIngestKey,
  updateAssistant,
} from "./assistants.js";
import { BadRequest, Conflict, NotFound, readJsonBody } from "./errors.js";
import { getDraft, listVersions, publishDraft, rollbackTo, updateDraft } from "./versions.js";

async function assistantRoutes(
  request: Request,
  segments: string[],
  tenant: Tenant,
): Promise<Response> {
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

/** Dispatches authenticated `/api/admin/*` requests with a tenant-scoped handle. */
export async function adminRoutes(request: Request, url: URL, tenant: Tenant): Promise<Response> {
  const segments = url.pathname.replace(/^\/api\/admin\//, "").split("/");
  try {
    if (segments[0] === "assistants") return await assistantRoutes(request, segments, tenant);
    return Response.json({ error: "Not found." }, { status: 404 });
  } catch (error) {
    // Mapped here, once: a handler building its own responses would eventually
    // leak an internal message into an owner's screen.
    if (error instanceof NotFound) return Response.json({ error: "Not found." }, { status: 404 });
    if (error instanceof BadRequest) {
      return Response.json({ error: "That is not valid.", fields: error.errors }, { status: 400 });
    }
    if (error instanceof Conflict) {
      return Response.json({ error: error.message || "Please try again." }, { status: 409 });
    }
    throw error;
  }
}
