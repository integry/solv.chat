import {
  type ChatEvent,
  newId,
  parseChatRequest,
  parseFeedbackRequest,
  serializeChatEvent,
} from "@solvchat/core";
import { assistantByPublicKey, assistantForMessage } from "../db/public.js";
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
import type { Seams } from "../seams/types.js";
import { answerMessage } from "./answer.js";
import { checkLimits, corsHeaders, matchedOrigin, runPublicChecks } from "./checks.js";

export interface ChatEnv {
  DB: D1Database;
  VECTORS: VectorizeIndex;
}

export interface ChatRouteOverrides {
  embedder?: Embedder | undefined;
  retriever?: Retriever | undefined;
  provider?: LlmProvider | undefined;
  model?: ModelInfo | undefined;
  providerKind?: "anthropic" | "openai" | undefined;
  tier?: Tier | undefined;
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

function readAssistantKey(body: unknown): string | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const raw = (body as Record<string, unknown>).assistant;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length < 4 || trimmed.length > 128) return null;
  if (!trimmed.startsWith("pk_") || /\s/.test(trimmed)) return null;
  return trimmed;
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
    return preflightResponse(request, "POST, OPTIONS");
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
    const assistant = assistantKey ? await assistantByPublicKey(env.DB, assistantKey) : null;
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

  const assistant = await assistantByPublicKey(env.DB, parsed.value.assistant);
  if (assistant === null) {
    return eventStreamOf({ type: "error", message: "This assistant is not available." });
  }

  const workerOrigin = new URL(request.url).origin;
  const requestOrigin = request.headers.get("origin");
  const isWorkerDraftRequest = parsed.value.target === "draft" && requestOrigin === workerOrigin;

  // Recognize authenticated same-organization owner previews from the Worker's
  // own origin before applying the visitor origin policy, since the admin
  // does not need to be in the assistant's website allowlist.
  const workerPrincipal = isWorkerDraftRequest ? await seams.auth.authenticate(request) : null;
  const isWorkerOwnerPreview =
    workerPrincipal !== null && workerPrincipal.orgId === assistant.orgId;

  const origin = matchedOrigin(assistant, request);
  const failure = isWorkerOwnerPreview
    ? await checkLimits(seams.limits, assistant, request)
    : await runPublicChecks(seams.limits, assistant, request);
  if (failure !== null) {
    return eventStreamOf({ type: "error", message: failure.message }, origin);
  }

  const tenant = forPublicScope(env.DB, {
    orgId: assistant.orgId,
    assistantId: assistant.id,
  });

  // The draft is served only to the owner. The field is ignored rather than
  // rejected for a visitor, so a stale widget cannot be made to fail.
  const principal = isWorkerDraftRequest
    ? workerPrincipal
    : parsed.value.target === "draft"
      ? await seams.auth.authenticate(request)
      : null;
  const useDraft =
    parsed.value.target === "draft" && principal !== null && principal.orgId === assistant.orgId;

  const version = useDraft
    ? await tenant.versions.draft(assistant.id)
    : await tenant.versions.published(assistant.id);

  if (version === null) {
    return eventStreamOf({ type: "error", message: "This assistant is not available." }, origin);
  }

  const providerKind = overrides?.providerKind ?? "anthropic";
  const tier = overrides?.tier ?? "balanced";
  const model =
    overrides?.model ??
    (providerKind === "anthropic" ? ANTHROPIC_MODELS[tier] : OPENAI_MODELS[tier]);

  const embedder =
    overrides?.embedder ??
    openAIEmbedder({ apiKey: await seams.keys.embeddingKey(assistant.orgId) });
  const retriever = overrides?.retriever ?? vectorizeRetriever(env.VECTORS);
  const provider =
    overrides?.provider ??
    (await llmProviderFor({ orgId: assistant.orgId, provider: providerKind, tier }, seams.keys));

  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const pipeline = (async () => {
        try {
          for await (const event of answerMessage(
            {
              tenant,
              embedder,
              retriever,
              provider,
              model,
              usage: seams.usage,
            },
            {
              orgId: assistant.orgId,
              assistantId: assistant.id,
              visitorId: parsed.value.visitorId,
              message: parsed.value.message,
              behaviour: version.config.behaviour,
              conversationId: parsed.value.conversationId,
              pageUrl: parsed.value.pageUrl,
            },
          )) {
            if (!cancelled) {
              controller.enqueue(encoder.encode(serializeChatEvent(event)));
            }
          }
        } catch (err) {
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

/** Handles `POST /v1/feedback` and its `OPTIONS` preflight. */
export async function feedbackRoute(
  request: Request,
  env: Pick<ChatEnv, "DB">,
  seams: Pick<Seams, "limits">,
): Promise<Response> {
  if (request.method === "OPTIONS") {
    return preflightResponse(request, "POST, OPTIONS");
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

  const assistant = await assistantForMessage(env.DB, parsed.value.messageId);
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
  seams: Pick<Seams, "limits">,
  publicKey: string,
): Promise<Response> {
  const assistant = await assistantByPublicKey(env.DB, publicKey);

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
    },
    { status: 200, headers: corsHeaders(origin) },
  );
}
