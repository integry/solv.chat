import { isPlainObject, type OperatorAccessCapabilities } from "@solvchat/core";
import type { VisitorCheckStatus } from "../chat/visitorCheck.js";
import type { Tenant } from "../db/tenant.js";
import { expectedVersionConfig, type VersionRow } from "../db/versions.js";
import { type IngestQueueMessage, TooLarge } from "../ingest/documents.js";
import { plainPageFetcher } from "../ingest/pageFetcher.js";
import type { RepeatedQueue } from "../ingest/repeatedSource.js";
import type { SyncStartDeps } from "../ingest/sync.js";
import { McpError } from "../mcp/types.js";
import type { EffectiveProviderSettings } from "../providers/config.js";
import type { Retriever } from "../providers/retrieval.js";
import type { KeyProvider, LlmProviderName, PageFetcher } from "../seams/types.js";
import { writeTheRightAnswer } from "./answers.js";
import {
  createTest,
  deleteTest,
  listTestRuns,
  listTests,
  type RunDeps,
  runAnswerTests,
  updateTest,
} from "./answerTests.js";
import {
  createAssistant,
  getAssistant,
  listAssistants,
  rotateIngestKey,
  updateAssistant,
} from "./assistants.js";
import { contentStatus } from "./contentStatus.js";
import {
  getAnswerTrace,
  getConversation,
  getPreviewTrace,
  listConversations,
  readConversationFilter,
} from "./conversations.js";
import { saveEntry } from "./entries.js";
import { BadRequest, Conflict, NotFound, readJsonBody } from "./errors.js";
import { dismissGap, listGaps, readGapsOpenOnly, restoreGap } from "./gaps.js";
import { getInstallInfo } from "./install.js";
import {
  createMcpServer,
  deleteMcpServer,
  listMcpServers,
  listMcpTools,
  type McpDeps,
  refreshMcpTools,
  setMcpToolAllowed,
  updateMcpServer,
} from "./mcp.js";
import { overviewFor } from "./overview.js";
import {
  getProviderSettingsView,
  type ProviderAdminDeps,
  parseProviderName,
  removeProviderKey,
  setProviderKey,
  testProviderKey,
  updateProviderSettings,
} from "./providers.js";
import { type ReindexDeps, ReindexRefused, reindexAssistant, reindexStatus } from "./reindex.js";
import { parseReportDays, reportFor } from "./reports.js";
import { importSitemapUrls, previewSitemap } from "./sitemap.js";
import { getSourceSync, readSyncNowBody, syncSourceNow } from "./sourceSync.js";
import {
  createSource,
  deleteSource,
  deleteSourceDocument,
  getRepeatedBlocks,
  getSourceDocument,
  listSourceDocuments,
  listSources,
  updateSource,
} from "./sources.js";
import { deleteTopic, listTopics, mergeTopic, renameTopic } from "./topics.js";
import {
  configRevision,
  getDraft,
  listVersions,
  publishDraft,
  rollbackTo,
  updateDraft,
} from "./versions.js";

export interface AdminRouteDeps {
  /**
   * Whether visitor chat runs the visitor check, for the admin's warning
   * and the Install screen. Optional so callers written before it compile;
   * absent, the admin says nothing about it.
   */
  visitorCheck?: (() => Promise<VisitorCheckStatus>) | undefined;
  previewChat?: ((request: Request) => Promise<Response>) | undefined;
  operatorEnabled?: boolean;
  operatorAccess?:
    | ((operation: "list" | "create" | "revoke", input?: unknown) => Promise<Response>)
    | undefined;
  tenant: Tenant;
  orgId: string;
  docs: Pick<R2Bucket, "get" | "put" | "delete">;
  queue: { send(message: IngestQueueMessage): Promise<unknown> };
  retriever: Pick<Retriever, "remove">;
  publicBaseUrl: string;
  fetchImpl?: typeof fetch | undefined;
  /** The page-fetcher seam. `createApp` always passes one; absent, the import uses `plainPageFetcher` over `fetchImpl`. */
  pages?: PageFetcher | undefined;
  costUnit?: "usd" | "credits" | undefined;
  resolveSettings?: (() => Promise<EffectiveProviderSettings>) | undefined;
  checkConfigError?: ((resolved?: EffectiveProviderSettings) => Promise<string | null>) | undefined;
  keys?: KeyProvider | undefined;
  envSecretPresence?: Record<LlmProviderName, boolean> | undefined;
  /**
   * SOLV_SECRET_KEY, passed down from app.ts. Not read through a seam: the
   * Biome rule in biome.json forbids importing seams/open outside worker.ts,
   * and createApp(seams) must not depend on the open build.
   */
  secretKey?: string | undefined;
  /** Lazily resolves provider/embedder/seams dependencies when running answer tests. */
  resolveRunDeps?: (() => Promise<RunDeps>) | undefined;
  /** What "Sync now" needs to start a run; `createApp` always passes it. */
  syncStart?: SyncStartDeps | undefined;
  /** What "Rebuild" (re-index from stored text) needs; `createApp` always passes it. */
  reindex?: Pick<ReindexDeps, "queue" | "limits"> | undefined;
}

function mcpDeps(deps: AdminRouteDeps): McpDeps {
  return {
    tenant: deps.tenant,
    secretKey: deps.secretKey ?? "",
    fetchImpl: deps.fetchImpl,
  };
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

function readAnswerFields(body: unknown): {
  question: string;
  answer: string;
  fromMessageId: string;
} {
  if (!isPlainObject(body)) {
    throw new BadRequest(["body: must be a JSON object"]);
  }
  return {
    question: typeof body.question === "string" ? body.question : "",
    answer: typeof body.answer === "string" ? body.answer : "",
    fromMessageId: typeof body.fromMessageId === "string" ? body.fromMessageId : "",
  };
}

function readPagingParams(url: URL): { limit?: number; offset?: number } {
  const rawLimit = url.searchParams.get("limit");
  const rawOffset = url.searchParams.get("offset");
  const limit = rawLimit !== null ? Number(rawLimit) : undefined;
  const offset = rawOffset !== null ? Number(rawOffset) : undefined;
  return {
    ...(limit !== undefined && Number.isFinite(limit) ? { limit } : {}),
    ...(offset !== undefined && Number.isFinite(offset) ? { offset } : {}),
  };
}

const DRAFT_CHANGED_MESSAGE =
  "The draft changed since you looked at what will change. Check the changes again, then publish.";
const DRAFT_CHANGED_CODE = "draft_changed";

/** `expected` on a publish request: the draft id and revision `GET .../draft` returned. */
function readExpectedDraft(raw: unknown): { draftId: string; revision: string } | undefined {
  if (raw === undefined) return undefined;
  if (
    !isPlainObject(raw) ||
    typeof raw.draftId !== "string" ||
    raw.draftId === "" ||
    typeof raw.revision !== "string" ||
    raw.revision === ""
  ) {
    throw new BadRequest(["expected: must have a draftId and a revision"]);
  }
  return { draftId: raw.draftId, revision: raw.revision };
}

/** The current draft when it is still the one confirmed; otherwise `draft_changed`. */
async function confirmedDraft(
  tenant: AdminRouteDeps["tenant"],
  assistantId: string,
  expected: { draftId: string; revision: string },
): Promise<VersionRow> {
  const draft = await getDraft(tenant, assistantId);
  if (draft.id !== expected.draftId || (await configRevision(draft)) !== expected.revision) {
    throw new Conflict(DRAFT_CHANGED_MESSAGE, DRAFT_CHANGED_CODE);
  }
  return draft;
}

function sameDraft(a: VersionRow, b: VersionRow): boolean {
  return a.id === b.id && expectedVersionConfig(a) === expectedVersionConfig(b);
}

async function maybeRunTestsBeforePublish(deps: AdminRouteDeps, assistantId: string) {
  const count = await deps.tenant.tests.countFor(assistantId);
  if (count === 0) return null;
  if (!deps.resolveRunDeps) {
    throw new Error("Answer test runner is not configured.");
  }
  return runAnswerTests(await deps.resolveRunDeps(), assistantId);
}

function providerAdminDeps(deps: AdminRouteDeps): ProviderAdminDeps {
  if (!deps.keys || !deps.resolveSettings || !deps.checkConfigError) {
    throw new NotFound();
  }
  return {
    tenant: deps.tenant,
    orgId: deps.orgId,
    keys: deps.keys,
    secretKey: deps.secretKey ?? "",
    envSecretPresence: deps.envSecretPresence ?? {
      anthropic: false,
      openai: false,
      openrouter: false,
    },
    fetchImpl: deps.fetchImpl,
    resolveSettings: deps.resolveSettings,
    checkConfigError: deps.checkConfigError,
  };
}

interface RouteContext {
  request: Request;
  url: URL;
  deps: AdminRouteDeps;
  params: Record<string, string>;
}

function route<const Name extends string>(
  name: Name,
  method: string,
  path: string,
  handle: (context: RouteContext) => Response | Promise<Response>,
) {
  return { name, method, path, handle };
}

/** This registry routes the admin API and is the source of truth for MCP parity. */
export const adminOperations = [
  route("list_assistants", "GET", "/assistants", async ({ deps }) => {
    const { tenant } = deps;
    const operatorAccess: OperatorAccessCapabilities | undefined = deps.operatorEnabled
      ? { manage: Boolean(deps.operatorAccess) }
      : undefined;
    return Response.json({
      assistants: await listAssistants(tenant),
      ...(deps.visitorCheck ? { visitorCheck: await deps.visitorCheck() } : {}),
      ...(operatorAccess ? { operatorAccess } : {}),
    });
  }),
  route("create_assistant", "POST", "/assistants", async ({ request, deps }) => {
    const { tenant } = deps;
    const result = await createAssistant(tenant, await readJsonBody(request));
    return Response.json(result, { status: 201 });
  }),
  route("get_assistant", "GET", "/assistants/:assistantId", async ({ deps, params }) => {
    const assistantId = params.assistantId ?? "";
    const { tenant } = deps;
    return Response.json({ assistant: await getAssistant(tenant, assistantId) });
  }),
  route(
    "update_assistant",
    "PATCH",
    "/assistants/:assistantId",
    async ({ request, deps, params }) => {
      const assistantId = params.assistantId ?? "";
      const { tenant } = deps;
      const assistant = await updateAssistant(tenant, assistantId, await readJsonBody(request));
      return Response.json({ assistant });
    },
  ),
  route(
    "rotate_ingest_key",
    "POST",
    "/assistants/:assistantId/ingest-key",
    async ({ deps, params }) => {
      const assistantId = params.assistantId ?? "";
      const { tenant } = deps;
      return Response.json({ ingestKey: await rotateIngestKey(tenant, assistantId) });
    },
  ),
  route("list_versions", "GET", "/assistants/:assistantId/versions", async ({ deps, params }) => {
    const assistantId = params.assistantId ?? "";
    const { tenant } = deps;
    return Response.json({ versions: await listVersions(tenant, assistantId) });
  }),
  route("get_draft", "GET", "/assistants/:assistantId/draft", async ({ deps, params }) => {
    const assistantId = params.assistantId ?? "";
    const { tenant } = deps;
    const draft = await getDraft(tenant, assistantId);
    // The revision Publish sends back (`expected`), so it publishes only
    // the draft the owner was shown.
    return Response.json({ draft, revision: await configRevision(draft) });
  }),
  route(
    "update_draft",
    "PUT",
    "/assistants/:assistantId/draft",
    async ({ request, deps, params }) => {
      const assistantId = params.assistantId ?? "";
      const { tenant } = deps;
      const draft = await updateDraft(tenant, assistantId, await readJsonBody(request));
      return Response.json({ draft });
    },
  ),
  route(
    "publish_draft",
    "POST",
    "/assistants/:assistantId/publish",
    async ({ request, deps, params }) => {
      const assistantId = params.assistantId ?? "";
      const { tenant } = deps;
      const body =
        request.headers.get("content-length") === "0"
          ? {}
          : await readJsonBody(request).catch(() => ({}));
      const force = isPlainObject(body) && body.force === true;
      const rawRunId = isPlainObject(body) ? body.runId : undefined;
      if (rawRunId !== undefined && (typeof rawRunId !== "string" || rawRunId.trim() === "")) {
        throw new BadRequest(["runId: must be a non-empty string"]);
      }
      // The draft the owner confirmed in "What will change". When given, only
      // that draft is published: a draft saved since (another tab, say) is
      // refused with `draft_changed`, and the admin shows the new comparison.
      const expected = readExpectedDraft(isPlainObject(body) ? body.expected : undefined);
      const confirmed =
        expected === undefined ? undefined : await confirmedDraft(tenant, assistantId, expected);

      if (force && typeof rawRunId === "string") {
        const reviewedRun = await tenant.tests.getRunForAssistant(assistantId, rawRunId);
        if (reviewedRun === null) {
          throw new NotFound("test run");
        }
        const draft = confirmed ?? (await getDraft(tenant, assistantId));
        const currentRevision = await configRevision(draft);
        if (
          reviewedRun.versionId !== draft.id ||
          reviewedRun.configHash === null ||
          reviewedRun.configHash !== currentRevision
        ) {
          throw new Conflict("The draft changed after those tests ran. Please try again.");
        }
        // The specification: "the choice is recorded on the run" — committed in
        // the same batch as promotion so the two cannot diverge.
        const version = await publishDraft(
          tenant,
          assistantId,
          draft,
          reviewedRun.passed ? undefined : reviewedRun.id,
        );
        return Response.json({
          version,
          run: { id: reviewedRun.id, passed: reviewedRun.passed },
        });
      }

      // The specification's order: tests, then promote. A run only happens if
      // the owner has tests; publishing with none is the phase 1 path exactly.
      const run = await maybeRunTestsBeforePublish(deps, assistantId);
      // The run read the draft again: a save between the check above and the
      // run means the tests judged something the owner was not shown.
      if (confirmed !== undefined && run !== null && !sameDraft(run.draft, confirmed)) {
        throw new Conflict(DRAFT_CHANGED_MESSAGE, DRAFT_CHANGED_CODE);
      }
      if (run !== null && !run.passed && !force) {
        // 409, not 400: the request was well formed, and the reason it did not
        // happen is a state the owner can inspect and then override.
        return Response.json(
          {
            error: "Some tests did not pass.",
            run: { id: run.runId, results: run.results, stopped: run.stopped ?? null },
          },
          { status: 409 },
        );
      }
      // The specification: "the choice is recorded on the run" — committed in
      // the same batch as promotion so the two cannot diverge.
      // Bound to the confirmed draft's exact config in the promoting batch,
      // so a save that lands after these checks still cannot go live.
      const version = await publishDraft(
        tenant,
        assistantId,
        run?.draft ?? confirmed,
        run !== null && !run.passed && force ? run.runId : undefined,
      );
      return Response.json({
        version,
        ...(run ? { run: { id: run.runId, passed: run.passed } } : {}),
      });
    },
  ),
  route("list_sources", "GET", "/assistants/:assistantId/sources", async ({ deps, params }) => {
    const assistantId = params.assistantId ?? "";
    const { tenant } = deps;
    return Response.json({ sources: await listSources(tenant, assistantId) });
  }),
  route(
    "get_content_status",
    "GET",
    "/assistants/:assistantId/content-status",
    async ({ deps, params }) => {
      const assistantId = params.assistantId ?? "";
      const { tenant } = deps;
      return Response.json(await contentStatus(tenant, assistantId));
    },
  ),
  route(
    "get_reindex_status",
    "GET",
    "/assistants/:assistantId/reindex",
    async ({ deps, params }) => {
      const assistantId = params.assistantId ?? "";
      const { tenant } = deps;
      return Response.json(await reindexStatus(tenant, assistantId));
    },
  ),
  route("start_reindex", "POST", "/assistants/:assistantId/reindex", async ({ deps, params }) => {
    const assistantId = params.assistantId ?? "";
    const { tenant } = deps;
    if (!deps.reindex) throw new NotFound();
    return Response.json(
      await reindexAssistant({ tenant, orgId: deps.orgId, ...deps.reindex }, assistantId),
      { status: 202 },
    );
  }),
  route(
    "create_source",
    "POST",
    "/assistants/:assistantId/sources",
    async ({ request, deps, params }) => {
      const assistantId = params.assistantId ?? "";
      const { tenant } = deps;
      const source = await createSource(tenant, assistantId, await readJsonBody(request));
      return Response.json({ source }, { status: 201 });
    },
  ),
  route(
    "create_entry",
    "POST",
    "/assistants/:assistantId/entries",
    async ({ request, deps, params }) => {
      const assistantId = params.assistantId ?? "";
      const { tenant } = deps;
      const fields = readEntryFields(await readJsonBody(request));
      const result = await saveEntry(
        { tenant, docs: deps.docs, queue: deps.queue, publicBaseUrl: deps.publicBaseUrl },
        { orgId: deps.orgId },
        { assistantId, ...fields },
      );
      return Response.json(result, { status: 201 });
    },
  ),
  route(
    "preview_sitemap",
    "POST",
    "/assistants/:assistantId/sitemap-preview",
    async ({ request, deps, params }) => {
      const assistantId = params.assistantId ?? "";
      const { tenant } = deps;
      const assistant = await tenant.assistants.get(assistantId);
      if (assistant === null) throw new NotFound("assistant");
      const body = await readJsonBody(request);
      if (!isPlainObject(body) || typeof body.url !== "string") {
        throw new BadRequest(["url: must be a string"]);
      }
      const urls = await previewSitemap(body.url, deps.fetchImpl);
      return Response.json({ urls });
    },
  ),
  route(
    "import_sitemap",
    "POST",
    "/assistants/:assistantId/sitemap-import",
    async ({ request, deps, params }) => {
      const assistantId = params.assistantId ?? "";
      const { tenant } = deps;
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
        deps.pages ?? plainPageFetcher({ fetch: deps.fetchImpl }),
      );
      return Response.json(result, { status: 201 });
    },
  ),
  route(
    "list_conversations",
    "GET",
    "/assistants/:assistantId/conversations",
    async ({ url, deps, params }) => {
      const assistantId = params.assistantId ?? "";
      const { tenant } = deps;
      return Response.json(
        await listConversations(tenant, assistantId, {
          ...readPagingParams(url),
          filter: readConversationFilter(url),
        }),
      );
    },
  ),
  route("list_gaps", "GET", "/assistants/:assistantId/gaps", async ({ url, deps, params }) => {
    const assistantId = params.assistantId ?? "";
    const { tenant } = deps;
    return Response.json(
      await listGaps(tenant, assistantId, {
        ...readPagingParams(url),
        openOnly: readGapsOpenOnly(url),
      }),
    );
  }),
  route(
    "write_answer",
    "POST",
    "/assistants/:assistantId/answers",
    async ({ request, deps, params }) => {
      const assistantId = params.assistantId ?? "";
      const { tenant } = deps;
      const fields = readAnswerFields(await readJsonBody(request));
      const result = await writeTheRightAnswer(
        { tenant, docs: deps.docs, queue: deps.queue, publicBaseUrl: deps.publicBaseUrl },
        { orgId: deps.orgId },
        { assistantId, ...fields },
      );
      return Response.json(result, { status: 201 });
    },
  ),
  route("get_overview", "GET", "/assistants/:assistantId/overview", async ({ deps, params }) => {
    const assistantId = params.assistantId ?? "";
    const { tenant } = deps;
    return Response.json(
      await overviewFor(tenant, assistantId, {
        costUnit: deps.costUnit,
        resolveSettings: deps.resolveSettings,
        checkConfigError: deps.checkConfigError,
      }),
    );
  }),
  route("get_report", "GET", "/assistants/:assistantId/report", async ({ url, deps, params }) => {
    const assistantId = params.assistantId ?? "";
    const { tenant } = deps;
    return Response.json(
      await reportFor(tenant, assistantId, parseReportDays(url.searchParams.get("days"))),
    );
  }),
  route("list_topics", "GET", "/assistants/:assistantId/topics", async ({ deps, params }) => {
    const assistantId = params.assistantId ?? "";
    const { tenant } = deps;
    return Response.json(await listTopics(tenant, assistantId));
  }),
  route(
    "get_install_snippet",
    "GET",
    "/assistants/:assistantId/install",
    async ({ deps, params }) => {
      const assistantId = params.assistantId ?? "";
      const { tenant } = deps;
      return Response.json(
        await getInstallInfo(tenant, assistantId, deps.publicBaseUrl, await deps.visitorCheck?.()),
      );
    },
  ),
  route(
    "list_tool_servers",
    "GET",
    "/assistants/:assistantId/mcp-servers",
    async ({ deps, params }) => {
      const assistantId = params.assistantId ?? "";
      const { tenant } = deps;
      return Response.json({ servers: await listMcpServers(tenant, assistantId) });
    },
  ),
  route(
    "add_tool_server",
    "POST",
    "/assistants/:assistantId/mcp-servers",
    async ({ request, deps, params }) => {
      const assistantId = params.assistantId ?? "";
      const result = await createMcpServer(mcpDeps(deps), assistantId, await readJsonBody(request));
      return Response.json(result, { status: 201 });
    },
  ),
  route("list_tests", "GET", "/assistants/:assistantId/tests", async ({ deps, params }) => {
    const assistantId = params.assistantId ?? "";
    const { tenant } = deps;
    return Response.json({ tests: await listTests(tenant, assistantId) });
  }),
  route(
    "create_test",
    "POST",
    "/assistants/:assistantId/tests",
    async ({ request, deps, params }) => {
      const assistantId = params.assistantId ?? "";
      const { tenant } = deps;
      const test = await createTest(tenant, assistantId, await readJsonBody(request));
      return Response.json({ test }, { status: 201 });
    },
  ),
  route("list_test_runs", "GET", "/assistants/:assistantId/test-runs", async ({ deps, params }) => {
    const assistantId = params.assistantId ?? "";
    const { tenant } = deps;
    return Response.json({ runs: await listTestRuns(tenant, assistantId) });
  }),
  route("run_tests", "POST", "/assistants/:assistantId/test-runs", async ({ deps, params }) => {
    const assistantId = params.assistantId ?? "";
    if (!deps.resolveRunDeps) {
      throw new Error("Answer test runner is not configured.");
    }
    const { draft: _draft, ...run } = await runAnswerTests(
      await deps.resolveRunDeps(),
      assistantId,
    );
    return Response.json(run, { status: 201 });
  }),
  route(
    "get_preview_trace",
    "GET",
    "/assistants/:assistantId/preview-traces/:traceId",
    async ({ deps, params }) => {
      const { assistantId = "", traceId = "" } = params;
      const { tenant } = deps;
      return Response.json(await getPreviewTrace(tenant, assistantId, traceId));
    },
  ),
  route(
    "rename_topic",
    "PATCH",
    "/assistants/:assistantId/topics/:topicId",
    async ({ request, deps, params }) => {
      const { assistantId = "", topicId = "" } = params;
      const { tenant } = deps;
      return Response.json(
        await renameTopic(tenant, assistantId, topicId, await readJsonBody(request)),
      );
    },
  ),
  route(
    "delete_topic",
    "DELETE",
    "/assistants/:assistantId/topics/:topicId",
    async ({ deps, params }) => {
      const { assistantId = "", topicId = "" } = params;
      const { tenant } = deps;
      return Response.json(await deleteTopic(tenant, assistantId, topicId));
    },
  ),
  route(
    "merge_topic",
    "POST",
    "/assistants/:assistantId/topics/:topicId/merge",
    async ({ request, deps, params }) => {
      const { assistantId = "", topicId = "" } = params;
      const { tenant } = deps;
      return Response.json(
        await mergeTopic(tenant, assistantId, topicId, await readJsonBody(request)),
      );
    },
  ),
  route(
    "dismiss_gap",
    "POST",
    "/assistants/:assistantId/gaps/dismiss",
    async ({ request, deps, params }) => {
      const assistantId = params.assistantId ?? "";
      const { tenant } = deps;
      return Response.json(await dismissGap(tenant, assistantId, await readJsonBody(request)));
    },
  ),
  route(
    "restore_gap",
    "POST",
    "/assistants/:assistantId/gaps/restore",
    async ({ request, deps, params }) => {
      const assistantId = params.assistantId ?? "";
      const { tenant } = deps;
      return Response.json(await restoreGap(tenant, assistantId, await readJsonBody(request)));
    },
  ),
  route(
    "rollback_version",
    "POST",
    "/assistants/:assistantId/versions/:versionId/rollback",
    async ({ deps, params }) => {
      const { assistantId = "", versionId = "" } = params;
      const { tenant } = deps;
      const version = await rollbackTo(tenant, assistantId, versionId);
      return Response.json({ version });
    },
  ),
  route("update_source", "PATCH", "/sources/:sourceId", async ({ request, deps, params }) => {
    const sourceId = params.sourceId ?? "";
    const { tenant } = deps;
    const source = await updateSource(tenant, sourceId, await readJsonBody(request));
    return Response.json({ source });
  }),
  route("delete_source", "DELETE", "/sources/:sourceId", async ({ deps, params }) => {
    const sourceId = params.sourceId ?? "";
    const { tenant } = deps;
    return Response.json(
      await deleteSource({ tenant, docs: deps.docs, retriever: deps.retriever }, sourceId),
    );
  }),
  route("list_documents", "GET", "/sources/:sourceId/documents", async ({ url, deps, params }) => {
    const sourceId = params.sourceId ?? "";
    const { tenant } = deps;
    return Response.json(await listSourceDocuments(tenant, sourceId, readPagingParams(url)));
  }),
  route(
    "get_repeated_blocks",
    "GET",
    "/sources/:sourceId/repeated-blocks",
    async ({ deps, params }) => {
      const sourceId = params.sourceId ?? "";
      const { tenant } = deps;
      return Response.json(await getRepeatedBlocks(tenant, deps.docs, sourceId));
    },
  ),
  route("get_sync_status", "GET", "/sources/:sourceId/sync", async ({ deps, params }) => {
    const sourceId = params.sourceId ?? "";
    const { tenant } = deps;
    return Response.json({ sync: await getSourceSync(tenant, sourceId) });
  }),
  route("start_sync", "POST", "/sources/:sourceId/sync", async ({ request, deps, params }) => {
    const sourceId = params.sourceId ?? "";
    const { tenant } = deps;
    if (!deps.syncStart) throw new NotFound();
    return Response.json(
      {
        sync: await syncSourceNow(
          deps.syncStart,
          tenant,
          deps.orgId,
          sourceId,
          await readSyncNowBody(request),
        ),
      },
      { status: 202 },
    );
  }),
  route(
    "create_source_entry",
    "POST",
    "/sources/:sourceId/entries",
    async ({ request, deps, params }) => {
      const sourceId = params.sourceId ?? "";
      const { tenant } = deps;
      const source = await tenant.sources.get(sourceId);
      if (source === null) throw new NotFound("source");
      const fields = readEntryFields(await readJsonBody(request));
      const result = await saveEntry(
        { tenant, docs: deps.docs, queue: deps.queue, publicBaseUrl: deps.publicBaseUrl },
        { orgId: deps.orgId },
        { assistantId: source.assistantId, sourceId, ...fields },
      );
      return Response.json(result, { status: 201 });
    },
  ),
  route(
    "get_document",
    "GET",
    "/sources/:sourceId/documents/:documentId",
    async ({ deps, params }) => {
      const { sourceId = "", documentId = "" } = params;
      const { tenant } = deps;
      return Response.json(await getSourceDocument(tenant, deps.docs, sourceId, documentId));
    },
  ),
  route(
    "delete_document",
    "DELETE",
    "/sources/:sourceId/documents/:documentId",
    async ({ deps, params }) => {
      const { sourceId = "", documentId = "" } = params;
      return Response.json(
        await deleteSourceDocument(
          {
            tenant: deps.tenant,
            docs: deps.docs,
            retriever: deps.retriever,
            repeated: { queue: deps.queue as unknown as RepeatedQueue, orgId: deps.orgId },
          },
          sourceId,
          documentId,
        ),
      );
    },
  ),
  route(
    "update_entry",
    "PUT",
    "/sources/:sourceId/entries/:documentId",
    async ({ request, deps, params }) => {
      const { sourceId = "", documentId = "" } = params;
      const { tenant } = deps;
      const source = await tenant.sources.get(sourceId);
      if (source === null) throw new NotFound("source");
      const fields = readEntryFields(await readJsonBody(request));
      const result = await saveEntry(
        { tenant, docs: deps.docs, queue: deps.queue, publicBaseUrl: deps.publicBaseUrl },
        { orgId: deps.orgId },
        { assistantId: source.assistantId, sourceId, documentId: documentId, ...fields },
      );
      return Response.json(result);
    },
  ),
  route("get_conversation", "GET", "/conversations/:conversationId", async ({ deps, params }) => {
    const conversationId = params.conversationId ?? "";
    return Response.json(await getConversation(deps.tenant, conversationId));
  }),
  route(
    "get_answer_trace",
    "GET",
    "/conversations/:conversationId/messages/:messageId/trace",
    async ({ deps, params }) => {
      const { conversationId = "", messageId = "" } = params;
      return Response.json(await getAnswerTrace(deps.tenant, conversationId, messageId));
    },
  ),
  route(
    "update_tool_server",
    "PATCH",
    "/mcp-servers/:serverId",
    async ({ request, deps, params }) => {
      const serverId = params.serverId ?? "";
      return Response.json(
        await updateMcpServer(mcpDeps(deps), serverId, await readJsonBody(request)),
      );
    },
  ),
  route("remove_tool_server", "DELETE", "/mcp-servers/:serverId", async ({ deps, params }) => {
    const serverId = params.serverId ?? "";
    return Response.json(await deleteMcpServer(deps.tenant, serverId));
  }),
  route(
    "refresh_tools",
    "POST",
    "/mcp-servers/:serverId/refresh",
    async ({ request, deps, params }) => {
      const serverId = params.serverId ?? "";
      const body = request.body === null ? undefined : await readJsonBody(request);
      const tools = await refreshMcpTools(mcpDeps(deps), serverId, body);
      return Response.json({ tools });
    },
  ),
  route("list_tools", "GET", "/mcp-servers/:serverId/tools", async ({ deps, params }) => {
    const serverId = params.serverId ?? "";
    return Response.json({ tools: await listMcpTools(deps.tenant, serverId) });
  }),
  route(
    "set_tool_allowed",
    "PATCH",
    "/mcp-servers/:serverId/tools/:toolId",
    async ({ request, deps, params }) => {
      const { serverId = "", toolId = "" } = params;
      return Response.json(
        await setMcpToolAllowed(deps.tenant, serverId, toolId, await readJsonBody(request)),
      );
    },
  ),
  route("get_provider_settings", "GET", "/providers", async ({ deps }) => {
    const pDeps = providerAdminDeps(deps);
    return Response.json(await getProviderSettingsView(pDeps));
  }),
  route("update_provider_settings", "PUT", "/providers", async ({ request, deps }) => {
    const pDeps = providerAdminDeps(deps);
    return Response.json(await updateProviderSettings(pDeps, await readJsonBody(request)));
  }),
  route(
    "set_provider_key",
    "PUT",
    "/providers/keys/:provider",
    async ({ request, deps, params }) => {
      const pDeps = providerAdminDeps(deps);
      const provider = parseProviderName(params.provider);
      if (!provider) throw new NotFound();
      return Response.json(await setProviderKey(pDeps, provider, await readJsonBody(request)));
    },
  ),
  route("remove_provider_key", "DELETE", "/providers/keys/:provider", async ({ deps, params }) => {
    const pDeps = providerAdminDeps(deps);
    const provider = parseProviderName(params.provider);
    if (!provider) throw new NotFound();
    return Response.json(await removeProviderKey(pDeps, provider));
  }),
  route("test_provider_key", "POST", "/providers/keys/:provider/test", ({ deps, params }) => {
    const pDeps = providerAdminDeps(deps);
    const provider = parseProviderName(params.provider);
    if (!provider) throw new NotFound();
    return testProviderKey(pDeps, provider);
  }),
  route("update_test", "PATCH", "/tests/:testId", async ({ request, deps, params }) => {
    const testId = params.testId ?? "";
    const test = await updateTest(deps.tenant, testId, await readJsonBody(request));
    return Response.json({ test });
  }),
  route("delete_test", "DELETE", "/tests/:testId", async ({ deps, params }) => {
    const testId = params.testId ?? "";
    return Response.json(await deleteTest(deps.tenant, testId));
  }),
  route("preview_answer", "POST", "/chat", ({ request, deps }) => {
    if (!deps.previewChat) throw new NotFound();
    return deps.previewChat(request);
  }),
  route("list_operator_access", "GET", "/operator-tokens", ({ deps }) => {
    if (!deps.operatorAccess) throw new NotFound();
    return deps.operatorAccess("list");
  }),
  route("create_personal_token", "POST", "/operator-tokens", async ({ request, deps }) => {
    if (!deps.operatorAccess) throw new NotFound();
    return deps.operatorAccess("create", await readJsonBody(request));
  }),
  route("revoke_operator_access", "DELETE", "/operator-tokens/:tokenId", ({ params, deps }) => {
    if (!deps.operatorAccess) throw new NotFound();
    return deps.operatorAccess("revoke", params.tokenId);
  }),
] as const;

export type AdminOperationName = (typeof adminOperations)[number]["name"];

export function matchAdminOperation(method: string, pathname: string) {
  if (!pathname.startsWith("/api/admin/")) return null;
  const segments = pathname.slice("/api/admin".length).split("/");
  for (const operation of adminOperations) {
    if (operation.method !== method) continue;
    const pattern = operation.path.split("/");
    if (pattern.length !== segments.length) continue;
    const params: Record<string, string> = {};
    if (
      pattern.every((part, index) => {
        const segment = segments[index] ?? "";
        if (!part.startsWith(":")) return part === segment;
        if (!segment) return false;
        try {
          params[part.slice(1)] = decodeURIComponent(segment);
          return true;
        } catch {
          return false;
        }
      })
    )
      return { operation, params };
  }
  return null;
}

/** Dispatches authenticated `/api/admin/*` requests with a tenant-scoped handle. */
export async function adminRoutes(
  request: Request,
  url: URL,
  deps: AdminRouteDeps,
): Promise<Response> {
  const match = matchAdminOperation(request.method, url.pathname);
  if (!match) return Response.json({ error: "Not found." }, { status: 404 });
  return runAdminOperation(match.operation, { request, url, deps, params: match.params });
}

export async function runAdminOperation(
  operation: (typeof adminOperations)[number],
  context: RouteContext,
): Promise<Response> {
  try {
    return await operation.handle(context);
  } catch (error) {
    // Mapped here, once: a handler building its own responses would eventually
    // leak an internal message into an owner's screen.
    if (error instanceof NotFound) return Response.json({ error: "Not found." }, { status: 404 });
    if (error instanceof BadRequest) {
      return Response.json(
        {
          error: "That is not valid.",
          fields: error.errors,
          ...(error.code !== undefined ? { code: error.code } : {}),
        },
        { status: 400 },
      );
    }
    if (error instanceof TooLarge) {
      return Response.json({ error: error.message }, { status: 413 });
    }
    if (error instanceof ReindexRefused) {
      return Response.json(
        { error: "Your plan's limits do not allow this right now." },
        { status: 429 },
      );
    }
    if (error instanceof Conflict) {
      return Response.json(
        {
          error: error.message || "Please try again.",
          ...(error.code !== undefined ? { code: error.code } : {}),
        },
        { status: 409 },
      );
    }
    if (error instanceof McpError) {
      // The server the owner pointed us at failed, not this request. The
      // message is already plain and carries no upstream body.
      return Response.json({ error: error.message }, { status: 502 });
    }
    throw error;
  }
}
