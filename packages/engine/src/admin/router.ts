import { isPlainObject } from "@solvchat/core";
import type { VisitorCheckStatus } from "../chat/visitorCheck.js";
import type { Tenant } from "../db/tenant.js";
import { expectedVersionConfig, type VersionRow } from "../db/versions.js";
import { type IngestQueueMessage, TooLarge } from "../ingest/documents.js";
import { plainPageFetcher } from "../ingest/pageFetcher.js";
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
      return Response.json({
        assistants: await listAssistants(tenant),
        ...(deps.visitorCheck ? { visitorCheck: await deps.visitorCheck() } : {}),
      });
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
      const draft = await getDraft(tenant, assistantId);
      // The revision Publish sends back (`expected`), so it publishes only
      // the draft the owner was shown.
      return Response.json({ draft, revision: await configRevision(draft) });
    }
    if (action === "draft" && method === "PUT") {
      const draft = await updateDraft(tenant, assistantId, await readJsonBody(request));
      return Response.json({ draft });
    }
    if (action === "publish" && method === "POST") {
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
    }
    if (action === "sources" && method === "GET") {
      return Response.json({ sources: await listSources(tenant, assistantId) });
    }
    if (action === "content-status" && method === "GET") {
      return Response.json(await contentStatus(tenant, assistantId));
    }
    if (action === "reindex" && method === "GET") {
      return Response.json(await reindexStatus(tenant, assistantId));
    }
    if (action === "reindex" && method === "POST") {
      if (!deps.reindex) throw new NotFound();
      return Response.json(
        await reindexAssistant({ tenant, orgId: deps.orgId, ...deps.reindex }, assistantId),
        { status: 202 },
      );
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
        deps.pages ?? plainPageFetcher({ fetch: deps.fetchImpl }),
      );
      return Response.json(result, { status: 201 });
    }
    if (action === "conversations" && method === "GET") {
      return Response.json(
        await listConversations(tenant, assistantId, {
          ...readPagingParams(url),
          filter: readConversationFilter(url),
        }),
      );
    }
    if (action === "gaps" && method === "GET") {
      return Response.json(
        await listGaps(tenant, assistantId, {
          ...readPagingParams(url),
          openOnly: readGapsOpenOnly(url),
        }),
      );
    }
    if (action === "answers" && method === "POST") {
      const fields = readAnswerFields(await readJsonBody(request));
      const result = await writeTheRightAnswer(
        { tenant, docs: deps.docs, queue: deps.queue, publicBaseUrl: deps.publicBaseUrl },
        { orgId: deps.orgId },
        { assistantId, ...fields },
      );
      return Response.json(result, { status: 201 });
    }
    if (action === "overview" && method === "GET") {
      return Response.json(
        await overviewFor(tenant, assistantId, {
          costUnit: deps.costUnit,
          resolveSettings: deps.resolveSettings,
          checkConfigError: deps.checkConfigError,
        }),
      );
    }
    if (action === "report" && method === "GET") {
      return Response.json(
        await reportFor(tenant, assistantId, parseReportDays(url.searchParams.get("days"))),
      );
    }
    if (action === "topics" && method === "GET") {
      return Response.json(await listTopics(tenant, assistantId));
    }
    if (action === "install" && method === "GET") {
      return Response.json(
        await getInstallInfo(tenant, assistantId, deps.publicBaseUrl, await deps.visitorCheck?.()),
      );
    }
    if (action === "mcp-servers" && method === "GET") {
      return Response.json({ servers: await listMcpServers(tenant, assistantId) });
    }
    if (action === "mcp-servers" && method === "POST") {
      const result = await createMcpServer(mcpDeps(deps), assistantId, await readJsonBody(request));
      return Response.json(result, { status: 201 });
    }
    if (action === "tests" && method === "GET") {
      return Response.json({ tests: await listTests(tenant, assistantId) });
    }
    if (action === "tests" && method === "POST") {
      const test = await createTest(tenant, assistantId, await readJsonBody(request));
      return Response.json({ test }, { status: 201 });
    }
    if (action === "test-runs" && method === "GET") {
      return Response.json({ runs: await listTestRuns(tenant, assistantId) });
    }
    if (action === "test-runs" && method === "POST") {
      if (!deps.resolveRunDeps) {
        throw new Error("Answer test runner is not configured.");
      }
      const { draft: _draft, ...run } = await runAnswerTests(
        await deps.resolveRunDeps(),
        assistantId,
      );
      return Response.json(run, { status: 201 });
    }
    throw new NotFound();
  }

  // `topics/:topicId` (rename, delete) and `topics/:topicId/merge`.
  // `assistants/:id/preview-traces/:traceId`: how a "Try it" or test-run answer was made.
  if (
    segments.length === 4 &&
    segments[2] === "preview-traces" &&
    segments[3] &&
    method === "GET"
  ) {
    return Response.json(await getPreviewTrace(tenant, assistantId, segments[3]));
  }
  if (segments[2] === "topics" && segments[3]) {
    const topicId = segments[3];
    if (segments.length === 4 && method === "PATCH") {
      return Response.json(
        await renameTopic(tenant, assistantId, topicId, await readJsonBody(request)),
      );
    }
    if (segments.length === 4 && method === "DELETE") {
      return Response.json(await deleteTopic(tenant, assistantId, topicId));
    }
    if (segments.length === 5 && segments[4] === "merge" && method === "POST") {
      return Response.json(
        await mergeTopic(tenant, assistantId, topicId, await readJsonBody(request)),
      );
    }
    throw new NotFound();
  }

  if (segments.length === 4 && segments[2] === "gaps" && method === "POST") {
    // "Dismiss" and its "Undo"; both name the gap group by its question.
    if (segments[3] === "dismiss") {
      return Response.json(await dismissGap(tenant, assistantId, await readJsonBody(request)));
    }
    if (segments[3] === "restore") {
      return Response.json(await restoreGap(tenant, assistantId, await readJsonBody(request)));
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
      return Response.json(
        await deleteSource({ tenant, docs: deps.docs, retriever: deps.retriever }, sourceId),
      );
    }
    throw new NotFound();
  }

  if (segments.length === 3) {
    const sub = segments[2];
    if (sub === "documents" && method === "GET") {
      return Response.json(await listSourceDocuments(tenant, sourceId, readPagingParams(url)));
    }
    if (sub === "repeated-blocks" && method === "GET") {
      return Response.json(await getRepeatedBlocks(tenant, deps.docs, sourceId));
    }
    if (sub === "sync" && method === "GET") {
      return Response.json({ sync: await getSourceSync(tenant, sourceId) });
    }
    if (sub === "sync" && method === "POST") {
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

async function conversationRoutes(
  request: Request,
  segments: string[],
  deps: AdminRouteDeps,
): Promise<Response> {
  const conversationId = segments[1];
  if (!conversationId || request.method !== "GET") throw new NotFound();
  if (segments.length === 2) {
    return Response.json(await getConversation(deps.tenant, conversationId));
  }
  // `conversations/:id/messages/:messageId/trace`: how one answer was made.
  if (
    segments.length === 5 &&
    segments[2] === "messages" &&
    segments[3] &&
    segments[4] === "trace"
  ) {
    return Response.json(await getAnswerTrace(deps.tenant, conversationId, segments[3]));
  }
  throw new NotFound();
}

async function mcpServerRoutes(
  request: Request,
  segments: string[],
  deps: AdminRouteDeps,
): Promise<Response> {
  const method = request.method;
  const serverId = segments[1];
  if (!serverId) throw new NotFound();

  if (segments.length === 2) {
    if (method === "PATCH") {
      return Response.json(
        await updateMcpServer(mcpDeps(deps), serverId, await readJsonBody(request)),
      );
    }
    if (method === "DELETE") {
      return Response.json(await deleteMcpServer(deps.tenant, serverId));
    }
    throw new NotFound();
  }

  if (segments.length === 3) {
    const sub = segments[2];
    if (sub === "refresh" && method === "POST") {
      const body = request.body === null ? undefined : await readJsonBody(request);
      const tools = await refreshMcpTools(mcpDeps(deps), serverId, body);
      return Response.json({ tools });
    }
    if (sub === "tools" && method === "GET") {
      return Response.json({ tools: await listMcpTools(deps.tenant, serverId) });
    }
    throw new NotFound();
  }

  if (segments.length === 4 && segments[2] === "tools" && segments[3] && method === "PATCH") {
    return Response.json(
      await setMcpToolAllowed(deps.tenant, serverId, segments[3], await readJsonBody(request)),
    );
  }

  throw new NotFound();
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

async function providerRoutes(
  request: Request,
  segments: string[],
  deps: AdminRouteDeps,
): Promise<Response> {
  const method = request.method;
  const pDeps = providerAdminDeps(deps);

  if (segments.length === 1) {
    if (method === "GET") {
      return Response.json(await getProviderSettingsView(pDeps));
    }
    if (method === "PUT") {
      return Response.json(await updateProviderSettings(pDeps, await readJsonBody(request)));
    }
    throw new NotFound();
  }

  if (segments[1] === "keys") {
    const provider = parseProviderName(segments[2]);
    if (!provider) throw new NotFound();

    if (segments.length === 3) {
      if (method === "PUT") {
        return Response.json(await setProviderKey(pDeps, provider, await readJsonBody(request)));
      }
      if (method === "DELETE") {
        return Response.json(await removeProviderKey(pDeps, provider));
      }
      throw new NotFound();
    }

    if (segments.length === 4 && segments[3] === "test" && method === "POST") {
      return testProviderKey(pDeps, provider);
    }
  }

  throw new NotFound();
}

async function testRoutes(
  request: Request,
  segments: string[],
  deps: AdminRouteDeps,
): Promise<Response> {
  const method = request.method;
  const testId = segments[1];
  if (!testId || segments.length !== 2) throw new NotFound();

  if (method === "PATCH") {
    const test = await updateTest(deps.tenant, testId, await readJsonBody(request));
    return Response.json({ test });
  }
  if (method === "DELETE") {
    return Response.json(await deleteTest(deps.tenant, testId));
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
    if (segments[0] === "conversations") return await conversationRoutes(request, segments, deps);
    if (segments[0] === "mcp-servers") return await mcpServerRoutes(request, segments, deps);
    if (segments[0] === "providers") return await providerRoutes(request, segments, deps);
    if (segments[0] === "tests") return await testRoutes(request, segments, deps);
    return Response.json({ error: "Not found." }, { status: 404 });
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
