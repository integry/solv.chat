import { adminAsset } from "./admin/assets.js";
import type { ReindexDeps } from "./admin/reindex.js";
import { adminRoutes } from "./admin/router.js";
import { type ReviewCatchUpResult, runReviewCatchUp } from "./chat/reviewCatchUp.js";
import {
  adminChatRoute,
  type ChatRouteOverrides,
  chatRoute,
  feedbackRoute,
  publicConfigRoute,
  resolveChatProviders,
} from "./chat/route.js";
import type { ScoreFloorEnv } from "./chat/scoreFloor.js";
import {
  resolveVisitorCheck,
  type VisitorCheckEnv,
  visitorCheckStatus,
} from "./chat/visitorCheck.js";
import {
  checkFrameRoute,
  checkFrameScript,
  visitorSessionRoute,
} from "./chat/visitorSessionRoute.js";
import { forPrincipal, forQueuedIngest, forScheduledSync, type Tenant } from "./db/tenant.js";
import { runIngestBatch } from "./ingest/consumer.js";
import { plainPageFetcher } from "./ingest/pageFetcher.js";
import {
  isRepeatedSourceMessage,
  type RepeatedQueue,
  runRepeatedSourceBatch,
} from "./ingest/repeatedSource.js";
import { type IngestResource, ingestRoutes } from "./ingest/router.js";
import {
  type DueSyncsResult,
  isSyncPageMessage,
  runDueSyncs,
  runSyncPageBatch,
  type SyncCaps,
  type SyncQueue,
} from "./ingest/sync.js";
import {
  checkLlmConfigError,
  embedderFor,
  type ProviderEnv,
  resolveProviderSettings,
} from "./providers/config.js";
import { vectorizeRetriever } from "./providers/retrieval.js";
import type { Seams } from "./seams/types.js";
import { scriptAsset } from "./util/scriptAsset.js";
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

const widgetAsset = scriptAsset(WIDGET_BUNDLE);

export interface Env extends ProviderEnv, ScoreFloorEnv, VisitorCheckEnv {
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
  /**
   * The Workers cron handler: starts the sitemap syncs that are due, and
   * reviews a few answers the live answer review left with no outcome
   * (`runReviewCatchUp`). One failing does not stop the other.
   */
  scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void>;
  /**
   * The same work as `scheduled`, for a host that runs its own cron: picks
   * the sitemap sources that are due and starts their runs. Safe to call
   * often (every 10 minutes, say) and from more than one place at once.
   */
  runDueSyncs(env: Env, options?: RunDueSyncsOptions): Promise<DueSyncsResult>;
  /**
   * The answer-review catch-up `scheduled` runs, for a host that runs its own
   * cron: reviews, once each, up to `maxAnswers` visitor replies from the last
   * 24 hours that have no outcome and no recorded review failure. Safe to call
   * from more than one place at once.
   */
  runReviewCatchUp(env: Env, options?: RunReviewCatchUpOptions): Promise<ReviewCatchUpResult>;
}

export interface RunReviewCatchUpOptions {
  /** Replies reviewed per call; defaults to `MAX_REVIEW_CATCH_UP_PER_TICK`. */
  maxAnswers?: number | undefined;
  now?: (() => number) | undefined;
}

export interface RunDueSyncsOptions {
  /** Sources started per call; defaults to `MAX_SYNC_SOURCES_PER_TICK`. */
  maxSources?: number | undefined;
  now?: (() => number) | undefined;
}

export interface AppOptions {
  chat?: ChatRouteOverrides | undefined;
  fetch?: typeof fetch | undefined;
  /** Lower the engine's sync caps for every source; the Limits seam may lower them further per run. */
  sync?: SyncCaps | undefined;
}

/** Creates the Worker fetch and queue handlers wired to the given extension seams. */
export function createApp(seams: Seams, options?: AppOptions): App {
  const chatOverrides: ChatRouteOverrides | undefined =
    options?.fetch && !options.chat?.fetch
      ? { ...options.chat, fetch: options.fetch }
      : options?.chat;
  // The fifth seam is optional so hosts written before it keep working.
  const pages = seams.pages ?? plainPageFetcher({ fetch: options?.fetch });
  const resolveQueuedOrg = (orgId: string) =>
    seams.auth.resolveOrg({ kind: "queued_ingest", orgId });

  const reviewCatchUp = (env: Env, runOptions?: RunReviewCatchUpOptions) =>
    runReviewCatchUp({
      db: env.DB,
      env,
      seams,
      overrides: chatOverrides,
      maxAnswers: runOptions?.maxAnswers,
      now: runOptions?.now,
    });
  const dueSyncs = (env: Env, runOptions?: RunDueSyncsOptions) =>
    runDueSyncs({
      db: env.DB,
      docs: env.DOCS,
      queue: env.INGEST_QUEUE as unknown as SyncQueue,
      retriever: vectorizeRetriever(env.VECTORS),
      limits: seams.limits,
      resolveOrg: resolveQueuedOrg,
      fetchImpl: options?.fetch,
      caps: options?.sync,
      maxSources: runOptions?.maxSources,
      now: runOptions?.now,
    });

  return {
    async scheduled(controller, env, ctx) {
      void controller;
      void ctx;
      // Both run every tick; one failing must not cost the other its turn.
      const [syncs, reviews] = await Promise.allSettled([dueSyncs(env), reviewCatchUp(env)]);
      if (reviews.status === "rejected") {
        console.error("chat: review catch-up did not run", {
          error: reviews.reason instanceof Error ? reviews.reason.name : typeof reviews.reason,
        });
      }
      if (syncs.status === "rejected") throw syncs.reason;
    },
    runDueSyncs: dueSyncs,
    runReviewCatchUp: reviewCatchUp,
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
      if (url.pathname === "/v1/session") {
        return visitorSessionRoute(request, env, { seams, fetchImpl: options?.fetch });
      }
      if (url.pathname === "/v1/check/frame") {
        return checkFrameRoute(request, env, { seams });
      }
      if (request.method === "GET" && url.pathname === "/v1/check/frame.js") {
        return checkFrameScript(request);
      }
      const publicConfigMatch = /^\/v1\/assistants\/([^/]+)$/.exec(url.pathname);
      if (publicConfigMatch?.[1]) {
        const publicKey = decodeSegment(publicConfigMatch[1]);
        if (publicKey === null) return notFound();
        return publicConfigRoute(request, env, seams, publicKey);
      }
      if (request.method === "GET" && url.pathname === "/widget.js") {
        return widgetAsset(request);
      }
      const resolveRunDeps = async (orgId: string, tenant: Tenant) => {
        const providers = await resolveChatProviders(env, seams, orgId, chatOverrides);
        return {
          tenant,
          orgId,
          ...providers,
          usage: seams.usage,
          limits: seams.limits,
          secretKey: env.SOLV_SECRET_KEY ?? "",
          fetchImpl: chatOverrides?.fetch,
          keys: seams.keys,
        };
      };
      const ingestMatch =
        /^\/v1\/ingest\/([^/]+)\/(documents|config|tests|test-runs|mcp-servers)$/.exec(
          url.pathname,
        );
      if (ingestMatch?.[1] && ingestMatch[2]) {
        const assistantId = decodeSegment(ingestMatch[1]);
        if (assistantId === null) return notFound();
        return ingestRoutes(request, assistantId, ingestMatch[2] as IngestResource, {
          db: env.DB,
          docs: env.DOCS,
          queue: env.INGEST_QUEUE,
          retriever: vectorizeRetriever(env.VECTORS),
          limits: seams.limits,
          auth: seams.auth,
          resolveRunDeps,
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
          visitorCheck: async () =>
            visitorCheckStatus(await resolveVisitorCheck(env, seams.visitorCheck)),
          tenant,
          orgId: principal.orgId,
          docs: env.DOCS,
          queue: env.INGEST_QUEUE,
          retriever: vectorizeRetriever(env.VECTORS),
          publicBaseUrl: url.origin,
          fetchImpl: options?.fetch,
          pages,
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
          resolveRunDeps: () => resolveRunDeps(principal.orgId, tenant),
          reindex: {
            queue: env.INGEST_QUEUE as unknown as ReindexDeps["queue"],
            limits: seams.limits,
          },
          syncStart: {
            docs: env.DOCS,
            queue: env.INGEST_QUEUE as unknown as SyncQueue,
            retriever: vectorizeRetriever(env.VECTORS),
            limits: seams.limits,
            fetchImpl: options?.fetch,
            caps: options?.sync,
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
      const resolveOrg = resolveQueuedOrg;
      for (const [claimedOrgId, messages] of byOrg) {
        // The message's org is a claim until the auth seam vouches for it:
        // no key is fetched and nothing is read for an org it refuses.
        const orgId = await resolveOrg(claimedOrgId);
        if (orgId === null) {
          for (const message of messages) message.ack();
          continue;
        }
        // Sync pages need no embedding key: they fetch and write a page, and
        // a changed page queues its own chunk-and-embed message.
        const syncPages = messages.filter((message) => isSyncPageMessage(message.body));
        // Nor does a source owed a reconciliation of its repeated blocks.
        const repeated = messages.filter((message) => isRepeatedSourceMessage(message.body));
        const ingest = messages.filter(
          (message) => !isSyncPageMessage(message.body) && !isRepeatedSourceMessage(message.body),
        );
        if (syncPages.length > 0) {
          await runSyncPageBatch(syncPages, {
            tenant: forScheduledSync(env.DB, orgId),
            orgId,
            docs: env.DOCS,
            queue: env.INGEST_QUEUE,
            pages,
          });
        }
        if (repeated.length > 0) {
          await runRepeatedSourceBatch(repeated, {
            tenant: forQueuedIngest(env.DB, orgId),
            orgId,
            queue: env.INGEST_QUEUE as unknown as RepeatedQueue,
          });
        }
        if (ingest.length === 0) continue;
        const settings = await resolveProviderSettings(env.DB, env, orgId);
        const embedder = await embedderFor(
          orgId,
          settings.embeddingsProvider.value,
          seams.keys,
          options?.fetch,
        );
        await runIngestBatch(
          { messages: ingest },
          {
            db: env.DB,
            docs: env.DOCS,
            embedder,
            retriever,
            usage: seams.usage,
            resolveOrg,
            queue: env.INGEST_QUEUE as unknown as RepeatedQueue,
          },
        );
      }
    },
  };
}
