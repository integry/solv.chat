import { isPlainObject } from "@solvchat/core";
import { validateTestReplacement } from "../admin/answerTests.js";
import { BadRequest } from "../admin/errors.js";
import { getDraft } from "../admin/versions.js";
import { forIngestScope, type IngestScope } from "../db/tenant.js";
import {
  type IngestResource,
  type IngestRouteDeps,
  scopedIngestRoutes,
  validateIngestDraft,
} from "../ingest/router.js";

type IngestDeps = Omit<IngestRouteDeps, "auth">;
export type CliOperation =
  | "apply_config"
  | "push_documents"
  | "prune_pushed_documents"
  | "delete_pushed_documents"
  | "run_declared_tests";

export async function runCliOperation(
  name: CliOperation,
  args: Record<string, unknown>,
  scope: IngestScope,
  origin: string,
  deps: IngestDeps,
): Promise<Response> {
  const ingest = (resource: IngestResource, method: string, body?: unknown) =>
    scopedIngestRoutes(
      new Request(origin, {
        method,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      scope,
      resource,
      deps,
    );
  const target = { source: args.source, sourceId: args.sourceId };
  if (name === "prune_pushed_documents") {
    if (!Array.isArray(args.keep))
      throw new BadRequest(["keep: provide the complete list of external IDs to keep"]);
    return ingest("documents", "DELETE", { ...target, prune: true, keep: args.keep });
  }
  if (name === "delete_pushed_documents") {
    return ingest("documents", "DELETE", { ...target, externalIds: args.externalIds });
  }
  if (name === "push_documents") {
    if (args.prune !== undefined && typeof args.prune !== "boolean") {
      throw new BadRequest(["prune: must be true or false"]);
    }
    const pushed = await ingest("documents", "PUT", { ...target, documents: args.documents });
    if (!pushed.ok || args.prune !== true) return pushed;
    // The write has validated every document. Prune only after the entire batch succeeds.
    const documents = args.documents as Array<{ externalId: string }>;
    const result = await ingest("documents", "DELETE", {
      ...target,
      prune: true,
      keep: documents.map(({ externalId }) => externalId.trim()),
    });
    if (!result.ok) {
      return Response.json(
        {
          error: "The batch was pushed, but pruning failed. Use prune_pushed_documents to retry.",
          push: await pushed.json(),
          details: await result.json(),
        },
        { status: result.status },
      );
    }
    const { deleted } = await result.json<{ deleted: number }>();
    return Response.json({ ...(await pushed.json<Record<string, unknown>>()), deleted });
  }
  if (name === "run_declared_tests") {
    const replaced = await ingest("tests", "PUT", { tests: args.tests });
    if (!replaced.ok) return replaced;
    return ingest("test-runs", "POST");
  }

  if (!isPlainObject(args.config))
    throw new BadRequest(["config: provide a solv.config.json object"]);
  const { tests, mcpServers, ...config } = args.config;
  validateIngestDraft(config);
  const tenant = forIngestScope(deps.db, scope);
  validateIngestDraft(config, (await getDraft(tenant, scope.assistantId)).config);
  if (tests !== undefined) validateTestReplacement({ tests });
  if (mcpServers !== undefined) {
    const check = await ingest("mcp-servers", "PUT", { servers: mcpServers, dryRun: true });
    if (!check.ok) return check;
  }
  const draft = await ingest("config", "PUT", config);
  if (!draft.ok) return draft;
  const data = await draft.json<Record<string, unknown>>();
  if (tests !== undefined) {
    const result = await ingest("tests", "PUT", { tests });
    if (!result.ok) return partialApply(data, "tests", result);
    data.tests = await result.json();
  }
  if (mcpServers !== undefined) {
    const result = await ingest("mcp-servers", "PUT", { servers: mcpServers });
    if (!result.ok) return partialApply(data, "tool server settings", result);
    data.mcpServers = await result.json();
  }
  return Response.json(data);
}

async function partialApply(applied: Record<string, unknown>, step: string, response: Response) {
  return Response.json(
    {
      error: `The draft was saved, but applying the ${step} failed. Review the changes before retrying.`,
      applied,
      details: await response.json(),
    },
    { status: response.status },
  );
}
