import {
  type ActionResult,
  type BehaviourConfig,
  type ChatEvent,
  type ChatHistoryTurn,
  newId,
  type PageAction,
  parseChatRequest,
  parseFeedbackRequest,
  serializeChatEvent,
  type VersionConfig,
} from "@solvchat/core";
import { assistantByPublicKey, assistantForMessage, originAllowedInOrg } from "../db/public.js";
import { forPublicScope } from "../db/tenant.js";
import { ANTHROPIC_MODELS, type ModelInfo, OPENAI_MODELS, type Tier } from "../models.js";
import {
  type EffectiveProviderSettings,
  embedderFor,
  type ProviderEnv,
  resolveProviderSettings,
} from "../providers/config.js";
import { ProviderError } from "../providers/error.js";
import { llmProviderFor } from "../providers/factory.js";
import { type Embedder, type Retriever, vectorizeRetriever } from "../providers/retrieval.js";
import type { LlmProvider } from "../providers/types.js";
import type { AuthProvider, LlmProviderName, Principal, Seams } from "../seams/types.js";
import { sha256Hex } from "../util/crypto.js";
import { matchesETag } from "../util/etag.js";
import { actionRunnerFor } from "./actionRunner.js";
import {
  type AnswerReviewHook,
  type AnswerTraceContext,
  answerMessage,
  answerWithActionResults,
} from "./answer.js";
import {
  checkLimits,
  corsHeaders,
  matchedOrigin,
  ORIGIN_REFUSAL_MESSAGE,
  runPublicChecks,
} from "./checks.js";
import { mcpRunnerFor } from "./mcpRunner.js";
import {
  type AnswerReviewer,
  modelReviewer,
  REVIEW_MAX_SUBJECT_TITLES,
  runAnswerReview,
} from "./review.js";
import { type ScoreFloorEnv, scoreFloorFrom } from "./scoreFloor.js";
import type { ToolRunner } from "./toolLoop.js";
import { modelKeySource } from "./trace.js";
import {
  CONFIG_REFUSAL,
  checkMessageCaps,
  checkSession,
  resolveVisitorCheck,
  type VisitorCheckEnv,
  type VisitorRefusal,
} from "./visitorCheck.js";

export interface ChatEnv extends ProviderEnv, ScoreFloorEnv, VisitorCheckEnv {
  DB: D1Database;
  VECTORS: VectorizeIndex;
  /** Opens stored MCP credentials at call time. */
  SOLV_SECRET_KEY?: string | undefined;
}

export interface ChatRouteOverrides {
  embedder?: Embedder | undefined;
  retriever?: Retriever | undefined;
  provider?: LlmProvider | undefined;
  model?: ModelInfo | undefined;
  providerKind?: LlmProviderName | undefined;
  tier?: Tier | undefined;
  fetch?: typeof fetch | undefined;
  /**
   * The answer reviewer to use instead of the fast-tier model call; null
   * reviews nothing. Left out while `provider` is given, nothing is reviewed
   * either: a substituted provider stands in for the whole provider layer,
   * and the review must not quietly reach a real one.
   */
  reviewer?: AnswerReviewer | null | undefined;
}

const encoder = new TextEncoder();

function sseHeaders(origin: string | null): Record<string, string> {
  return {
    "content-type": "text/event-stream; charset=utf-8",
    // `no-transform` asks Cloudflare not to compress or otherwise change the
    // stream, so nothing on the way gathers tokens into larger pieces. The
    // page lists the compressed types (text/event-stream is not one) and says
    // compression can be disabled "by including a `cache-control: no-transform`
    // HTTP header in the response from your origin web server".
    // Source: https://developers.cloudflare.com/speed/optimization/content/compression/
    // — checked 2026-11-21
    "cache-control": "no-cache, no-transform",
    ...corsHeaders(origin),
  };
}

function eventStreamOf(event: ChatEvent, origin: string | null = null): Response {
  const payload = encoder.encode(serializeChatEvent(event));
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(payload);
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: sseHeaders(origin),
  });
}

function preflightResponse(
  request: Request,
  methods: string,
  originOverride?: string | null,
): Response {
  const origin = originOverride === undefined ? request.headers.get("origin") : originOverride;
  const headers: Record<string, string> = {
    "access-control-allow-methods": methods,
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
    ...corsHeaders(origin),
  };
  return new Response(null, { status: 204, headers });
}

/**
 * Preflight for a route whose assistant is named only in the body. The Origin
 * is echoed only when one of the org's assistants allows it, so a site on no
 * allow-list is told no as early as the browser asks. The org comes from the
 * auth seam, as for every session-less request.
 */
export async function bodyKeyedPreflight(
  request: Request,
  db: D1Database,
  auth: Pick<AuthProvider, "resolveOrg">,
  methods: string,
): Promise<Response> {
  const origin = request.headers.get("origin");
  if (origin === null) return preflightResponse(request, methods, null);
  const orgId = await auth.resolveOrg({ kind: "preflight", origin });
  const allowed = orgId !== null && (await originAllowedInOrg(db, orgId, origin));
  return preflightResponse(request, methods, allowed ? origin : null);
}

/** The org's assistant for a public key, with the org taken from the auth seam. */
export async function publicAssistant(
  db: D1Database,
  auth: Pick<AuthProvider, "resolveOrg">,
  publicKey: string,
) {
  const orgId = await auth.resolveOrg({ kind: "public_key", publicKey });
  return orgId === null ? null : assistantByPublicKey(db, orgId, publicKey);
}

/**
 * Writes an Overview checklist milestone without letting it fail the request
 * it rides on. Only the error's message is logged, never the request.
 */
async function recordMilestone(name: string, write: () => Promise<void>): Promise<void> {
  try {
    await write();
  } catch (err) {
    console.error("overview: milestone write failed", {
      milestone: name,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function readAssistantKey(body: unknown): string | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const raw = (body as Record<string, unknown>).assistant;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length < 4 || trimmed.length > 128) return null;
  if (!trimmed.startsWith("pk_") || /\s/.test(trimmed)) return null;
  return trimmed;
}

interface SiteNames {
  name: string;
  title: string;
  greeting: string;
  persona: string;
}

/** What the answer review is told the site is: owner-written text only. */
function siteNames(name: string, config: VersionConfig): SiteNames {
  return {
    name,
    title: config.widget.title,
    greeting: config.behaviour.greeting,
    persona: config.behaviour.persona,
  };
}

interface StreamAnswerParams {
  env: ChatEnv;
  seams: Seams;
  ctx: Pick<ExecutionContext, "waitUntil">;
  overrides: ChatRouteOverrides | undefined;
  tenant: ReturnType<typeof forPublicScope>;
  orgId: string;
  assistantId: string;
  visitorId: string;
  message: string;
  behaviour: BehaviourConfig;
  /**
   * The version's tool allow-list: published for a visitor, draft for the
   * owner's preview. Taken from the same row the behaviour came from, so the
   * two can never disagree about which version is answering.
   */
  allowedTools: readonly string[];
  /** The version the behaviour and tools came from, for the answer's trace. */
  version: AnswerTraceContext["version"];
  /** What the answer review is told about the site (name, widget title, greeting, persona). */
  site: SiteNames;
  conversationId: string | undefined;
  pageUrl: string | undefined;
  preview: boolean;
  history: ChatHistoryTurn[] | undefined;
  pageActions: readonly PageAction[] | undefined;
  actionsEnabled: boolean;
  origin: string | null;
  /**
   * Runs once the answer is complete, before its `done` event is sent: an
   * answer that fails (no provider key, say) never reaches it.
   */
  onAnswered?: () => Promise<void>;
}

interface StreamResumeParams {
  env: ChatEnv;
  seams: Seams;
  ctx: Pick<ExecutionContext, "waitUntil">;
  overrides: ChatRouteOverrides | undefined;
  tenant: ReturnType<typeof forPublicScope>;
  orgId: string;
  assistantId: string;
  visitorId: string;
  behaviour: BehaviourConfig;
  /** The published version's tool allow-list, as for a fresh answer. */
  allowedTools: readonly string[];
  version: AnswerTraceContext["version"];
  site: SiteNames;
  conversationId: string;
  resumeMessageId: string;
  actionResults: readonly ActionResult[];
  pageActions: readonly PageAction[] | undefined;
  actionsEnabled: boolean;
  origin: string | null;
}

/** Resolves the embedder, retriever, LLM provider, and model for chat or test runs. */
export async function resolveChatProviders(
  env: ChatEnv,
  seams: Seams,
  orgId: string,
  overrides?: ChatRouteOverrides,
): Promise<{
  embedder: Embedder;
  retriever: Retriever;
  provider: LlmProvider;
  model: ModelInfo | undefined;
  /** The settings this was resolved from, read once: the answer review needs them too. */
  settings: EffectiveProviderSettings;
  providerKind: LlmProviderName;
  tier: Tier;
  /** The retrieval score floor, `SOLV_SCORE_FLOOR` or the default. */
  scoreFloor: number;
}> {
  const resolved = await resolveProviderSettings(env.DB, env, orgId);
  const providerKind = overrides?.providerKind ?? resolved.llmProvider.value;
  const tier = providerKind === "openrouter" ? "fast" : (overrides?.tier ?? resolved.llmTier.value);
  const model =
    overrides?.model ??
    (providerKind === "anthropic"
      ? ANTHROPIC_MODELS[tier]
      : providerKind === "openai"
        ? OPENAI_MODELS[tier]
        : undefined);
  const embeddingsProvider = resolved.embeddingsProvider.value;

  const embedder =
    overrides?.embedder ??
    (await embedderFor(orgId, embeddingsProvider, seams.keys, overrides?.fetch));
  const retriever = overrides?.retriever ?? vectorizeRetriever(env.VECTORS);
  const provider =
    overrides?.provider ??
    (await llmProviderFor(
      {
        orgId,
        provider: providerKind,
        tier,
        model: resolved.llmModel.value ?? undefined,
        fetchImpl: overrides?.fetch,
      },
      seams.keys,
    ));

  return {
    embedder,
    retriever,
    provider,
    model,
    settings: resolved,
    providerKind,
    tier,
    scoreFloor: scoreFloorFrom(env),
  };
}

/**
 * How the answer review gets its reviewer, or null for none. Built on first
 * use inside the deferred review, so the visitor's request reads no extra key.
 * The reviewer is the fast tier of the provider that answered (the same
 * configured model on OpenRouter, which has no tiers), with the same key.
 * The scheduled catch-up gives no answering provider: one is built the same
 * way, from the org's settings.
 */
export function reviewerSource(params: {
  seams: Seams;
  overrides: ChatRouteOverrides | undefined;
  orgId: string;
  assistantId: string;
  providerKind: LlmProviderName;
  tier: Tier;
  /** The provider that answered; absent in the catch-up. */
  provider?: LlmProvider | undefined;
  /** The configured model (OpenRouter's only model), when no provider is given. */
  configuredModel?: string | undefined;
}): (() => Promise<AnswerReviewer>) | null {
  const { overrides, seams } = params;
  if (overrides?.reviewer !== undefined) {
    const reviewer = overrides.reviewer;
    return reviewer === null ? null : async () => reviewer;
  }
  if (overrides?.provider !== undefined) return null;
  return async () => {
    const fastModel =
      params.providerKind === "anthropic"
        ? ANTHROPIC_MODELS.fast
        : params.providerKind === "openai"
          ? OPENAI_MODELS.fast
          : undefined;
    const provider =
      params.provider !== undefined &&
      (params.providerKind === "openrouter" || params.tier === "fast")
        ? params.provider
        : await llmProviderFor(
            {
              orgId: params.orgId,
              provider: params.providerKind,
              tier: "fast",
              model: params.providerKind === "openrouter" ? params.configuredModel : undefined,
              fetchImpl: overrides?.fetch,
            },
            seams.keys,
          );
    return modelReviewer({
      provider,
      model: fastModel,
      // Recorded like any model use, through the seam: it counts toward the
      // daily spend cap and `usage_daily`, and never as a message. One event
      // per call that reported usage (each provider reports once per call),
      // so a retry and a catch-up call are metered like the first.
      onUsage: (tokensIn, tokensOut, cost) =>
        seams.usage.record({
          orgId: params.orgId,
          assistantId: params.assistantId,
          at: Date.now(),
          messages: 0,
          tokensIn,
          tokensOut,
          costMicros: cost ?? 0,
          ...(cost === null ? { costUnknown: true } : {}),
        }),
    });
  };
}

async function resolveAnswerDeps(params: {
  env: ChatEnv;
  seams: Seams;
  ctx: Pick<ExecutionContext, "waitUntil">;
  overrides: ChatRouteOverrides | undefined;
  tenant: ReturnType<typeof forPublicScope>;
  orgId: string;
  assistantId: string;
  allowedTools: readonly string[];
  version: AnswerTraceContext["version"];
  site: SiteNames;
  pageActions: readonly PageAction[] | undefined;
  actionsEnabled: boolean;
  preview: boolean;
}) {
  const { env, seams, overrides } = params;
  const { embedder, retriever, provider, model, settings, providerKind, tier, scoreFloor } =
    await resolveChatProviders(env, seams, params.orgId, overrides);

  const actionRunner = params.preview
    ? null
    : actionRunnerFor(params.pageActions, { builtinsEnabled: params.actionsEnabled });
  const reservedNames = actionRunner ? actionRunner.definitions.map((d) => d.name) : [];
  // No tool switched on and published means no runner, so the request
  // carries no `tools` key and this is phase 1 behaviour exactly.
  const mcp = await mcpRunnerFor(
    {
      tenant: params.tenant,
      secretKey: env.SOLV_SECRET_KEY ?? "",
      fetchImpl: overrides?.fetch,
    },
    params.assistantId,
    params.allowedTools,
    reservedNames,
  );
  const runners: ToolRunner[] = [];
  if (actionRunner) runners.push(actionRunner);
  if (mcp) runners.push(mcp);

  // The key source is read by the trace write after `done`, never before the
  // answer starts. A preview ("Try it") stores no message, so its trace is
  // kept apart from visitor replies, marked as one.
  const trace: AnswerTraceContext = {
    version: params.version,
    keySource: () => modelKeySource(params.tenant.providerSettings, seams.keys, provider.name),
    ...(params.preview ? { preview: { source: "try_it" as const } } : {}),
  };

  // Previews ("Try it") are not reviewed; test runs do not come through here.
  const reviewer =
    params.preview || !settings.reviewAnswers.value
      ? null
      : reviewerSource({
          seams,
          overrides,
          orgId: params.orgId,
          assistantId: params.assistantId,
          providerKind,
          tier,
          provider,
        });
  // Deferred work of its own (`waitUntil`), not part of the answer's stream:
  // the stream closes when the answer is done, and the review runs after.
  // With "Review answers" off (reviewer null) only a retrieval miss is
  // scheduled, and it is stored as `declined` without a call, as before.
  const review: AnswerReviewHook | undefined = params.preview
    ? undefined
    : {
        schedule(job) {
          if (reviewer === null && !job.retrievalMiss) return;
          params.ctx.waitUntil(
            runAnswerReview(
              {
                messages: params.tenant.messages,
                topics: params.tenant.topics,
                // A review that gives no usable result says why, in the trace.
                traces: params.tenant.traces,
                // What the site is about, read in the deferred review: the
                // names it answers as, the owner's greeting and persona (of
                // the version that answered) and some of its content's titles.
                subject: async (assistantId) => ({
                  name: params.site.name,
                  title: params.site.title,
                  greeting: params.site.greeting,
                  persona: params.site.persona,
                  contentTitles: await params.tenant.documents.titlesForAssistant(
                    assistantId,
                    REVIEW_MAX_SUBJECT_TITLES,
                  ),
                }),
                reviewer,
                limits: seams.limits,
                usage: seams.usage,
              },
              job,
            ),
          );
        },
      };

  return {
    tenant: params.tenant,
    embedder,
    retriever,
    provider,
    model,
    usage: seams.usage,
    scoreFloor,
    runners,
    trace,
    review,
  };
}

function streamEventsResponse(
  origin: string | null,
  ctx: Pick<ExecutionContext, "waitUntil">,
  produce: () => AsyncIterable<ChatEvent>,
): Response {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const pipeline = (async () => {
        try {
          for await (const event of produce()) {
            if (!cancelled) {
              controller.enqueue(encoder.encode(serializeChatEvent(event)));
            }
          }
        } catch (err) {
          if (!(err instanceof ProviderError)) {
            // The visitor only sees "Something went wrong", so this line is how
            // a self-hoster finds a missing secret or a failing D1 call. Name
            // and message only: `secretKeys` errors name the variable, never
            // its value, and no request body is included.
            console.error("chat: answer pipeline failed", {
              name: err instanceof Error ? err.name : typeof err,
              message: err instanceof Error ? err.message : String(err),
            });
          }
          if (!cancelled) {
            const message =
              err instanceof ProviderError
                ? "The assistant could not complete this response."
                : "Something went wrong. Please try again.";
            controller.enqueue(encoder.encode(serializeChatEvent({ type: "error", message })));
          }
        } finally {
          if (!cancelled) {
            controller.close();
          }
        }
      })();

      // Keep the answer pipeline alive if the client disconnects mid-stream so
      // assistant message persistence and usage accounting still complete.
      ctx.waitUntil(pipeline);
    },
    cancel() {
      cancelled = true;
    },
  });

  return new Response(stream, {
    status: 200,
    headers: sseHeaders(origin),
  });
}

function streamAnswerResponse(params: StreamAnswerParams): Response {
  return streamEventsResponse(params.origin, params.ctx, async function* () {
    const deps = await resolveAnswerDeps(params);
    const events = answerMessage(deps, {
      orgId: params.orgId,
      assistantId: params.assistantId,
      visitorId: params.visitorId,
      message: params.message,
      behaviour: params.behaviour,
      conversationId: params.conversationId,
      pageUrl: params.pageUrl,
      preview: params.preview,
      history: params.history,
      pageActions: params.preview ? undefined : params.pageActions,
    });
    for await (const event of events) {
      if (event.type === "done" && params.onAnswered) await params.onAnswered();
      yield event;
    }
  });
}

function streamResumeResponse(params: StreamResumeParams): Response {
  return streamEventsResponse(params.origin, params.ctx, async function* () {
    const deps = await resolveAnswerDeps({ ...params, preview: false });
    yield* answerWithActionResults(deps, {
      orgId: params.orgId,
      assistantId: params.assistantId,
      visitorId: params.visitorId,
      conversationId: params.conversationId,
      resumeMessageId: params.resumeMessageId,
      actionResults: params.actionResults,
      behaviour: params.behaviour,
      pageActions: params.pageActions,
    });
  });
}

/** Handles authenticated `POST /api/admin/chat` draft previews. */
export async function adminChatRoute(
  request: Request,
  env: ChatEnv,
  seams: Seams,
  ctx: Pick<ExecutionContext, "waitUntil">,
  principal: Principal,
  overrides?: ChatRouteOverrides,
): Promise<Response> {
  if (request.method !== "POST") {
    return Response.json({ error: "Not found." }, { status: 404 });
  }

  const body = await request.json().catch(() => null);
  const parsed = parseChatRequest(body);
  if (!parsed.ok) {
    return eventStreamOf({
      type: "error",
      message: parsed.errors[0] ?? "Invalid chat request.",
    });
  }

  // The signed-in owner's org, from `authenticate`: a key from another org
  // matches no row.
  const assistant = await assistantByPublicKey(env.DB, principal.orgId, parsed.value.assistant);
  if (assistant === null) {
    return eventStreamOf({ type: "error", message: "This assistant is not available." });
  }

  const failure = await checkLimits(seams.limits, assistant, request);
  if (failure !== null) {
    return eventStreamOf({ type: "error", message: failure.message });
  }

  const tenant = forPublicScope(env.DB, {
    orgId: assistant.orgId,
    assistantId: assistant.id,
  });
  const version = await tenant.versions.draft(assistant.id);
  if (version === null) {
    return eventStreamOf({ type: "error", message: "This assistant is not available." });
  }

  const message = parsed.value.message;
  if (parsed.value.actionResults !== undefined || message === undefined) {
    return eventStreamOf({ type: "error", message: "Resuming actions is not supported yet." });
  }

  // The Overview checklist's "Try a question" step: previews store no
  // conversation, so this is the only record that the owner tried one. It is
  // written once the answer is complete, so a preview that fails (no provider
  // key, say) leaves the step unticked. Written once (the lookup above read
  // the column), and a failed write only leaves a step unticked: the preview
  // answers anyway.
  const onAnswered =
    assistant.triedAt === null
      ? () => recordMilestone("tried", () => tenant.assistants.markTried(assistant.id, Date.now()))
      : undefined;

  return streamAnswerResponse({
    env,
    seams,
    ctx,
    overrides,
    tenant,
    orgId: assistant.orgId,
    assistantId: assistant.id,
    visitorId: parsed.value.visitorId,
    message,
    behaviour: version.config.behaviour,
    allowedTools: version.config.allowedTools,
    version: { id: version.id, state: "draft" },
    site: siteNames(assistant.name, version.config),
    conversationId: parsed.value.conversationId,
    pageUrl: parsed.value.pageUrl,
    preview: true,
    history: parsed.value.history,
    // The preview has no page, so there is nothing to offer and nothing to resume.
    pageActions: undefined,
    actionsEnabled: false,
    origin: null,
    ...(onAnswered ? { onAnswered } : {}),
  });
}

/** Handles `POST /v1/chat` and its `OPTIONS` preflight. */
export async function chatRoute(
  request: Request,
  env: ChatEnv,
  seams: Seams,
  ctx: Pick<ExecutionContext, "waitUntil">,
  overrides?: ChatRouteOverrides,
): Promise<Response> {
  if (request.method === "OPTIONS") {
    return bodyKeyedPreflight(request, env.DB, seams.auth, "POST, OPTIONS");
  }
  if (request.method !== "POST") {
    return Response.json({ error: "Not found." }, { status: 404 });
  }

  const body = await request.json().catch(() => null);
  const parsed = parseChatRequest(body);
  if (!parsed.ok) {
    // Resolve the assistant's allowed origin even when validation fails (e.g.
    // unsupported protocol version) so a widget on an allowed site can read
    // the error event across origins.
    const assistantKey = readAssistantKey(body);
    const assistant = assistantKey ? await publicAssistant(env.DB, seams.auth, assistantKey) : null;
    const origin = assistant ? matchedOrigin(assistant, request) : null;
    // A protocol or body we cannot parse is answered as a stream too, so the
    // widget has one code path for every failure instead of two.
    return eventStreamOf(
      {
        type: "error",
        message: parsed.errors[0] ?? "Invalid chat request.",
      },
      origin,
    );
  }

  const assistant = await publicAssistant(env.DB, seams.auth, parsed.value.assistant);
  if (assistant === null) {
    return eventStreamOf({ type: "error", message: "This assistant is not available." });
  }

  // The draft is never served here: owner previews go through the signed-in
  // `/api/admin/chat`, so this public route needs no session handling at all.
  // `target: "draft"` is ignored rather than rejected so a stale client
  // cannot be made to fail.
  const origin = matchedOrigin(assistant, request);
  // The checks, in order, each refusing before any model, embedding or tool
  // call: Origin; the visitor session (when the visitor check is on); the
  // per-IP rate limit and the spend cap (the Limits seam); then the
  // per-visitor caps on a new message.
  const refusal = (failure: VisitorRefusal) =>
    eventStreamOf({ type: "error", message: failure.message, code: failure.code }, origin);
  if (origin === null) {
    // The same sentence `runPublicChecks` gives, so a prober learns nothing.
    return eventStreamOf({ type: "error", message: ORIGIN_REFUSAL_MESSAGE }, null);
  }
  const visitorCheck = await resolveVisitorCheck(env, seams.visitorCheck);
  if (visitorCheck.state === "misconfigured") return refusal(CONFIG_REFUSAL);
  const now = Date.now();
  if (visitorCheck.state === "on") {
    const failure = await checkSession(
      visitorCheck,
      { orgId: assistant.orgId, assistantId: assistant.id, visitorId: parsed.value.visitorId },
      parsed.value.session,
      now,
    );
    if (failure !== null) return refusal(failure);
  }
  const failure = await runPublicChecks(seams.limits, assistant, request);
  if (failure !== null) {
    return eventStreamOf({ type: "error", message: failure.message }, origin);
  }
  // Caps count new questions only: a continuation of a paused answer is not one.
  if (visitorCheck.state === "on" && parsed.value.actionResults === undefined) {
    const capped = await checkMessageCaps(
      env.DB,
      visitorCheck,
      {
        orgId: assistant.orgId,
        assistantId: assistant.id,
        visitorId: parsed.value.visitorId,
        ip: request.headers.get("cf-connecting-ip") ?? "",
        conversationId: parsed.value.conversationId,
      },
      now,
    );
    if (capped !== null) return refusal(capped);
  }

  const tenant = forPublicScope(env.DB, {
    orgId: assistant.orgId,
    assistantId: assistant.id,
  });
  const version = await tenant.versions.published(assistant.id);
  if (version === null) {
    return eventStreamOf({ type: "error", message: "This assistant is not available." }, origin);
  }

  // A resuming request continues an answer instead of starting one. Same
  // guards, same version, same visitor: only the body differs.
  if (parsed.value.actionResults !== undefined) {
    return streamResumeResponse({
      env,
      seams,
      ctx,
      overrides,
      tenant,
      orgId: assistant.orgId,
      assistantId: assistant.id,
      visitorId: parsed.value.visitorId,
      behaviour: version.config.behaviour,
      allowedTools: version.config.allowedTools,
      version: { id: version.id, state: "published" },
      site: siteNames(assistant.name, version.config),
      conversationId: parsed.value.conversationId ?? "",
      resumeMessageId: parsed.value.resumeMessageId ?? "",
      actionResults: parsed.value.actionResults,
      pageActions: parsed.value.pageActions,
      actionsEnabled: version.config.actions.builtins,
      origin,
    });
  }

  const message = parsed.value.message;
  if (message === undefined) {
    return eventStreamOf({ type: "error", message: "Invalid chat request." }, origin);
  }

  return streamAnswerResponse({
    env,
    seams,
    ctx,
    overrides,
    tenant,
    orgId: assistant.orgId,
    assistantId: assistant.id,
    visitorId: parsed.value.visitorId,
    message,
    behaviour: version.config.behaviour,
    allowedTools: version.config.allowedTools,
    version: { id: version.id, state: "published" },
    site: siteNames(assistant.name, version.config),
    conversationId: parsed.value.conversationId,
    pageUrl: parsed.value.pageUrl,
    preview: false,
    history: undefined,
    pageActions: parsed.value.pageActions,
    actionsEnabled: version.config.actions.builtins,
    origin,
  });
}

/** Handles `POST /v1/feedback` and its `OPTIONS` preflight. */
export async function feedbackRoute(
  request: Request,
  env: Pick<ChatEnv, "DB"> & VisitorCheckEnv,
  seams: Pick<Seams, "limits" | "auth" | "visitorCheck">,
): Promise<Response> {
  if (request.method === "OPTIONS") {
    return bodyKeyedPreflight(request, env.DB, seams.auth, "POST, OPTIONS");
  }
  if (request.method !== "POST") {
    return Response.json({ error: "Not found." }, { status: 404 });
  }

  const body = await request.json().catch(() => null);
  const parsed = parseFeedbackRequest(body);
  if (!parsed.ok) {
    return Response.json(
      { error: parsed.errors[0] ?? "Invalid feedback request." },
      { status: 400 },
    );
  }

  const orgId = await seams.auth.resolveOrg({
    kind: "message",
    messageId: parsed.value.messageId,
  });
  const assistant =
    orgId === null ? null : await assistantForMessage(env.DB, orgId, parsed.value.messageId);
  if (assistant === null) {
    return Response.json({ error: "Not found." }, { status: 404 });
  }

  const origin = matchedOrigin(assistant, request);
  if (origin !== null) {
    // Feedback writes a row, so it needs a session too, checked after Origin.
    const visitorCheck = await resolveVisitorCheck(env, seams.visitorCheck);
    const failure =
      visitorCheck.state === "misconfigured"
        ? CONFIG_REFUSAL
        : visitorCheck.state === "on"
          ? await checkSession(
              visitorCheck,
              {
                orgId: assistant.orgId,
                assistantId: assistant.id,
                visitorId: parsed.value.visitorId,
              },
              parsed.value.session,
              Date.now(),
            )
          : null;
    if (failure !== null) {
      return Response.json(
        { error: failure.message, code: failure.code },
        { status: failure.code === "check_config" ? 503 : 403, headers: corsHeaders(origin) },
      );
    }
  }
  const failure = await runPublicChecks(seams.limits, assistant, request);
  if (failure !== null) {
    return Response.json(
      { error: failure.message },
      { status: failure.reason === "origin" ? 403 : 429, headers: corsHeaders(origin) },
    );
  }

  const tenant = forPublicScope(env.DB, {
    orgId: assistant.orgId,
    assistantId: assistant.id,
  });

  const saved = await tenant.feedback.upsert({
    id: newId("fbk"),
    messageId: parsed.value.messageId,
    visitorId: parsed.value.visitorId,
    value: parsed.value.value,
    note: parsed.value.note,
    createdAt: Date.now(),
  });

  return Response.json({ ok: true, id: saved.id }, { status: 200, headers: corsHeaders(origin) });
}

/** Handles `GET /v1/assistants/:publicKey` and its `OPTIONS` preflight. */
export async function publicConfigRoute(
  request: Request,
  env: Pick<ChatEnv, "DB"> & VisitorCheckEnv,
  seams: Pick<Seams, "limits" | "auth" | "visitorCheck">,
  publicKey: string,
): Promise<Response> {
  const assistant = await publicAssistant(env.DB, seams.auth, publicKey);

  if (request.method === "OPTIONS") {
    const origin = assistant ? matchedOrigin(assistant, request) : null;
    return preflightResponse(request, "GET, OPTIONS", origin);
  }
  const origin = assistant ? matchedOrigin(assistant, request) : null;
  const headers = { ...corsHeaders(origin), vary: "Origin", "cache-control": "no-store" };
  if (request.method !== "GET" || assistant === null) {
    return Response.json({ error: "Not found." }, { status: 404, headers });
  }

  const failure = await runPublicChecks(seams.limits, assistant, request, "config");
  if (failure !== null) {
    return Response.json(
      { error: failure.message },
      { status: failure.reason === "origin" ? 403 : 429, headers },
    );
  }

  const tenant = forPublicScope(env.DB, {
    orgId: assistant.orgId,
    assistantId: assistant.id,
  });
  const published = await tenant.versions.published(assistant.id);
  if (published === null) {
    return Response.json({ error: "Not found." }, { status: 404, headers });
  }

  // The Overview checklist's "Install on your site" step. Written once: the
  // lookup above already read the column, so later config requests skip the write.
  // A failed write only leaves a step unticked: the widget still loads.
  if (origin !== null && assistant.widgetSeenAt === null) {
    await recordMilestone("widget_seen", () =>
      tenant.assistants.markWidgetSeen(assistant.id, Date.now()),
    );
  }

  const visitorCheckOn = (await resolveVisitorCheck(env, seams.visitorCheck)).state === "on";

  const body = JSON.stringify({
    title: published.config.widget.title,
    accentColor: published.config.widget.accentColor,
    position: published.config.widget.position,
    // Stored versions from before the setting have no value: on, as the default.
    allowExpand: published.config.widget.allowExpand !== false,
    greeting: published.config.behaviour.greeting,
    suggestedQuestions: [...published.config.behaviour.suggestedQuestions],
    // What the widget needs to gate the built-ins and check a navigate
    // target. No secrets: both values are the owner's public choices.
    actions: {
      builtins: published.config.actions.builtins,
      allowedOrigins: [...published.config.actions.allowedOrigins],
    },
    // Present only when the visitor check runs: the widget then starts it
    // on the first focus or keystroke. Left out otherwise, so an engine
    // without it answers exactly as before.
    ...(visitorCheckOn ? { visitorCheck: true } : {}),
  });
  const etag = `"${await sha256Hex(body)}"`;
  const cacheHeaders = {
    ...headers,
    "cache-control": "private, max-age=60, must-revalidate, no-transform",
    etag,
  };
  if (matchesETag(request.headers.get("if-none-match"), etag)) {
    return new Response(null, { status: 304, headers: cacheHeaders });
  }
  return new Response(body, {
    headers: { ...cacheHeaders, "content-type": "application/json" },
  });
}
