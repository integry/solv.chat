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
} from "@solvchat/core";
import { assistantByPublicKey, assistantForMessage, originAllowedInOrg } from "../db/public.js";
import { forPublicScope } from "../db/tenant.js";
import { ANTHROPIC_MODELS, type ModelInfo, OPENAI_MODELS, type Tier } from "../models.js";
import { ProviderError } from "../providers/error.js";
import { llmProviderFor } from "../providers/factory.js";
import {
  type Embedder,
  openAIEmbedder,
  type Retriever,
  vectorizeRetriever,
} from "../providers/retrieval.js";
import type { LlmProvider } from "../providers/types.js";
import type { AuthProvider, Principal, Seams } from "../seams/types.js";
import { actionRunnerFor } from "./actionRunner.js";
import { answerMessage, answerWithActionResults } from "./answer.js";
import { checkLimits, corsHeaders, matchedOrigin, runPublicChecks } from "./checks.js";
import { mcpRunnerFor } from "./mcpRunner.js";
import type { ToolRunner } from "./toolLoop.js";

export interface ChatEnv {
  DB: D1Database;
  VECTORS: VectorizeIndex;
  SOLV_LLM_PROVIDER?: string | undefined;
  SOLV_LLM_TIER?: string | undefined;
  /** Opens stored MCP credentials at call time. */
  SOLV_SECRET_KEY?: string | undefined;
}

const DEFAULT_PROVIDER = "anthropic" as const;
const DEFAULT_TIER: Tier = "fast";
const warnedConfigVars = new Set<string>();

function warnInvalidConfigOnce(
  name: "SOLV_LLM_PROVIDER" | "SOLV_LLM_TIER",
  fallback: string,
): void {
  if (warnedConfigVars.has(name)) return;
  warnedConfigVars.add(name);
  // Do not log or otherwise trust the unrecognised value's content.
  console.warn(`Unrecognised ${name} configuration; falling back to default (${fallback}).`);
}

function resolveProvider(raw: string | undefined): "anthropic" | "openai" {
  if (raw === undefined) return DEFAULT_PROVIDER;
  if (raw === "anthropic" || raw === "openai") return raw;
  warnInvalidConfigOnce("SOLV_LLM_PROVIDER", DEFAULT_PROVIDER);
  return DEFAULT_PROVIDER;
}

function resolveTier(raw: string | undefined): Tier {
  if (raw === undefined) return DEFAULT_TIER;
  if (raw === "fast" || raw === "balanced") return raw;
  warnInvalidConfigOnce("SOLV_LLM_TIER", DEFAULT_TIER);
  return DEFAULT_TIER;
}

export interface ChatRouteOverrides {
  embedder?: Embedder | undefined;
  retriever?: Retriever | undefined;
  provider?: LlmProvider | undefined;
  model?: ModelInfo | undefined;
  providerKind?: "anthropic" | "openai" | undefined;
  tier?: Tier | undefined;
  fetch?: typeof fetch | undefined;
}

const encoder = new TextEncoder();

function sseHeaders(origin: string | null): Record<string, string> {
  return {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
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
async function bodyKeyedPreflight(
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
async function publicAssistant(
  db: D1Database,
  auth: Pick<AuthProvider, "resolveOrg">,
  publicKey: string,
) {
  const orgId = await auth.resolveOrg({ kind: "public_key", publicKey });
  return orgId === null ? null : assistantByPublicKey(db, orgId, publicKey);
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
  conversationId: string | undefined;
  pageUrl: string | undefined;
  preview: boolean;
  history: ChatHistoryTurn[] | undefined;
  pageActions: readonly PageAction[] | undefined;
  actionsEnabled: boolean;
  origin: string | null;
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
  model: ModelInfo;
}> {
  const providerKind = overrides?.providerKind ?? resolveProvider(env.SOLV_LLM_PROVIDER);
  const tier = overrides?.tier ?? resolveTier(env.SOLV_LLM_TIER);
  const model =
    overrides?.model ??
    (providerKind === "anthropic" ? ANTHROPIC_MODELS[tier] : OPENAI_MODELS[tier]);

  const embedder =
    overrides?.embedder ?? openAIEmbedder({ apiKey: await seams.keys.embeddingKey(orgId) });
  const retriever = overrides?.retriever ?? vectorizeRetriever(env.VECTORS);
  const provider =
    overrides?.provider ??
    (await llmProviderFor({ orgId, provider: providerKind, tier }, seams.keys));

  return { embedder, retriever, provider, model };
}

async function resolveAnswerDeps(params: {
  env: ChatEnv;
  seams: Seams;
  overrides: ChatRouteOverrides | undefined;
  tenant: ReturnType<typeof forPublicScope>;
  orgId: string;
  assistantId: string;
  allowedTools: readonly string[];
  pageActions: readonly PageAction[] | undefined;
  actionsEnabled: boolean;
  preview: boolean;
}) {
  const { env, seams, overrides } = params;
  const { embedder, retriever, provider, model } = await resolveChatProviders(
    env,
    seams,
    params.orgId,
    overrides,
  );

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

  return {
    tenant: params.tenant,
    embedder,
    retriever,
    provider,
    model,
    usage: seams.usage,
    runners,
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
    yield* answerMessage(deps, {
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
    conversationId: parsed.value.conversationId,
    pageUrl: parsed.value.pageUrl,
    preview: true,
    history: parsed.value.history,
    // The preview has no page, so there is nothing to offer and nothing to resume.
    pageActions: undefined,
    actionsEnabled: false,
    origin: null,
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
  const failure = await runPublicChecks(seams.limits, assistant, request);
  if (failure !== null) {
    return eventStreamOf({ type: "error", message: failure.message }, origin);
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
  env: Pick<ChatEnv, "DB">,
  seams: Pick<Seams, "limits" | "auth">,
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
  env: Pick<ChatEnv, "DB">,
  seams: Pick<Seams, "limits" | "auth">,
  publicKey: string,
): Promise<Response> {
  const assistant = await publicAssistant(env.DB, seams.auth, publicKey);

  if (request.method === "OPTIONS") {
    const origin = assistant ? matchedOrigin(assistant, request) : null;
    return preflightResponse(request, "GET, OPTIONS", origin);
  }
  if (request.method !== "GET") {
    return Response.json({ error: "Not found." }, { status: 404 });
  }
  if (assistant === null) {
    return Response.json({ error: "Not found." }, { status: 404 });
  }

  const origin = matchedOrigin(assistant, request);
  const failure = await runPublicChecks(seams.limits, assistant, request, "config");
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
  const published = await tenant.versions.published(assistant.id);
  if (published === null) {
    return Response.json({ error: "Not found." }, { status: 404 });
  }

  return Response.json(
    {
      title: published.config.widget.title,
      accentColor: published.config.widget.accentColor,
      position: published.config.widget.position,
      greeting: published.config.behaviour.greeting,
      suggestedQuestions: [...published.config.behaviour.suggestedQuestions],
      // What the widget needs to gate the built-ins and check a navigate
      // target. No secrets: both values are the owner's public choices.
      actions: {
        builtins: published.config.actions.builtins,
        allowedOrigins: [...published.config.actions.allowedOrigins],
      },
    },
    { status: 200, headers: corsHeaders(origin) },
  );
}
