import {
  type ActionResult,
  type BehaviourConfig,
  type ChatEvent,
  newId,
  type PageAction,
} from "@solvchat/core";
import type { Tenant } from "../db/tenant.js";
import { type ResolvedChunk, resolveChunks } from "../ingest/resolve.js";
import type { ModelInfo } from "../models.js";
import { ProviderError } from "../providers/error.js";
import { type Embedder, embeddingCostMicros, type Retriever } from "../providers/retrieval.js";
import type { LlmMessage, LlmProvider, LlmToolResult, ToolCall } from "../providers/types.js";
import type { UsageSink } from "../seams/types.js";
import { buildPrompt, MAX_TURNS } from "./prompt.js";
import {
  MAX_TOOL_CALLS_PER_CONVERSATION,
  resumeToolLoop,
  runToolLoop,
  type StoredToolCall,
  type ToolRunner,
} from "./toolLoop.js";

// A chunk below the floor is noise; including it would make the model answer
// from unrelated pages, which is worse than admitting the gap. The numbers are
// ours: the spec says "above a score floor" and stops.
export const SCORE_FLOOR = 0.3;
export const TOP_K = 6;

export interface AnswerDeps {
  tenant: Tenant;
  embedder: Embedder;
  retriever: Retriever;
  provider: LlmProvider;
  model: ModelInfo;
  usage: UsageSink;
  now?: (() => number) | undefined;
  /**
   * Tool sources for this answer. Empty (the default) reproduces phase 1
   * exactly: no `tools` key on the request, one model call.
   */
  runners?: readonly ToolRunner[] | undefined;
}

export interface AnswerInput {
  orgId: string;
  assistantId: string;
  visitorId: string;
  message: string;
  behaviour: BehaviourConfig;
  conversationId?: string | undefined;
  pageUrl?: string | undefined;
  preview?: boolean | undefined;
  history?: readonly LlmMessage[] | undefined;
  pageActions?: readonly PageAction[] | undefined;
}

export interface ResumeInput {
  orgId: string;
  assistantId: string;
  visitorId: string;
  conversationId: string;
  resumeMessageId: string;
  actionResults: readonly ActionResult[];
  behaviour: BehaviourConfig;
  pageActions?: readonly PageAction[] | undefined;
}

const encoder = new TextEncoder();

function confirmFor(name: string, pageActions: readonly PageAction[] | undefined): boolean {
  return name === "fill" || (pageActions?.find((a) => a.name === name)?.confirm ?? false);
}

/**
 * The chunks a visitor can follow. Hand-written entries are excluded: their
 * URL points into the admin, where a visitor meets a sign-in screen.
 */
function citableByUrl(chunks: readonly ResolvedChunk[]): ResolvedChunk[] {
  const seen = new Set<string>();
  const out: ResolvedChunk[] = [];
  for (const chunk of chunks) {
    if (chunk.sourceKind === "entry") continue;
    if (seen.has(chunk.url)) continue;
    seen.add(chunk.url);
    out.push(chunk);
  }
  return out;
}

async function ensureConversation(
  deps: AnswerDeps,
  input: AnswerInput,
  now: number,
): Promise<{ conversationId: string; history: LlmMessage[] }> {
  if (input.preview) {
    // Owner previews stay out of D1 so they never appear in Conversations or
    // Gaps; the pane resends its own recent turns in the request body.
    return {
      conversationId: newId("cnv"),
      history: input.history ? [...input.history] : [],
    };
  }

  if (input.conversationId !== undefined) {
    const existing = await deps.tenant.conversations.get(input.conversationId);
    if (
      existing !== null &&
      existing.assistantId === input.assistantId &&
      existing.visitorId === input.visitorId
    ) {
      // Only what the prompt can use: a long conversation should not cost a
      // full read on every turn.
      const prior = await deps.tenant.messages.recent(existing.id, MAX_TURNS);
      return {
        conversationId: existing.id,
        history: prior.map((m) => ({ role: m.role, content: m.content })),
      };
    }
  }

  const conversationId = newId("cnv");
  await deps.tenant.conversations.create({
    id: conversationId,
    assistantId: input.assistantId,
    visitorId: input.visitorId,
    startedAt: now,
    pageUrl: input.pageUrl ?? "",
  });
  return { conversationId, history: [] };
}

async function recordMessageUsage(
  deps: AnswerDeps,
  input: Pick<AnswerInput, "orgId" | "assistantId">,
  at: number,
  tokensIn: number,
  tokensOut: number,
  cost: number,
  messages = 1,
): Promise<void> {
  // Usage goes through the seam, never straight into usage_daily: the hosted
  // service meters and bills from these events.
  await deps.usage.record({
    orgId: input.orgId,
    assistantId: input.assistantId,
    at,
    messages,
    tokensIn,
    tokensOut,
    costMicros: cost,
  });
}

/**
 * Records spend that is not a message — the question was embedded but no
 * answer was produced — so `usage_daily.messages` keeps counting answers only.
 */
async function recordEmbeddingOnly(
  deps: AnswerDeps,
  input: Pick<AnswerInput, "orgId" | "assistantId">,
  at: number,
  cost: number,
): Promise<void> {
  if (cost === 0) return;
  await deps.usage.record({
    orgId: input.orgId,
    assistantId: input.assistantId,
    at,
    messages: 0,
    tokensIn: 0,
    tokensOut: 0,
    costMicros: cost,
  });
}

/**
 * Runs the retrieval, prompt, streaming, citation, persistence, and usage
 * pipeline for one visitor message.
 */
export async function* answerMessage(
  deps: AnswerDeps,
  input: AnswerInput,
): AsyncIterable<ChatEvent> {
  const clock = deps.now ?? Date.now;
  const { conversationId, history } = await ensureConversation(deps, input, clock());

  // Persist the visitor's message before calling anything: if the provider
  // fails, the owner still sees the question in Conversations, which is the
  // only way they can find out what went wrong.
  // Every reply below records this id, so Gaps and "Write the right answer"
  // follow the question this request asked, even if another request appended
  // a question to the same conversation while this one was retrieving.
  const questionId = newId("msg");
  if (!input.preview) {
    await deps.tenant.messages.create({
      id: questionId,
      conversationId,
      role: "user",
      content: input.message,
      citations: [],
      toolCalls: null,
      tokensIn: 0,
      tokensOut: 0,
      answered: true,
      createdAt: clock(),
    });
  }

  // The question's embedding is billed whatever happens next — a failing
  // retriever, D1 read or model call must not make it vanish — so it is
  // recorded the moment the provider reports it, as spend that is not a
  // message. The answer's own usage event below carries model tokens only.
  const embedded = await deps.embedder.embed([input.message], (tokens) =>
    recordEmbeddingOnly(deps, input, clock(), embeddingCostMicros(tokens)),
  );
  const [vector] = embedded.vectors;
  if (!vector) {
    yield { type: "error", message: "The assistant could not complete this response." };
    return;
  }

  const hits = await deps.retriever.query({
    vector,
    orgId: input.orgId,
    assistantId: input.assistantId,
    topK: TOP_K,
  });
  const aboveFloor = hits.filter((hit) => hit.score >= SCORE_FLOOR);
  const chunks = await resolveChunks(deps.tenant, input.assistantId, aboveFloor);

  if (chunks.length === 0) {
    // No model call at all: there is nothing to answer from, so spending a
    // request to have the model say so is waste — and it might answer anyway
    // from its own training.
    yield { type: "token", text: input.behaviour.fallbackText };
    // Counted before the reply is stored, as on the model path below: the
    // visitor has already been answered, so a failing write must not erase it.
    await recordMessageUsage(deps, input, clock(), 0, 0, 0);
    const messageId = newId("msg");
    if (!input.preview) {
      await deps.tenant.messages.create({
        id: messageId,
        conversationId,
        role: "assistant",
        content: input.behaviour.fallbackText,
        citations: [],
        toolCalls: null,
        tokensIn: 0,
        tokensOut: 0,
        answered: false,
        createdAt: clock(),
        replyTo: questionId,
      });
    }
    yield { type: "done", messageId, conversationId };
    return;
  }

  const request = buildPrompt({
    behaviour: input.behaviour,
    chunks,
    history,
    question: input.message,
  });

  // Atomically reserve conversation tool budget before dispatch so failed
  // answers and concurrent requests cannot exceed the per-conversation cap.
  // Previews have no stored conversation row and stay bounded in-memory.
  const reserveCalls = input.preview
    ? undefined
    : (count: number) =>
        deps.tenant.conversations.reserveToolCalls(
          conversationId,
          count,
          MAX_TOOL_CALLS_PER_CONVERSATION,
        );

  let text = "";
  let toolCalls: StoredToolCall[] = [];
  let pending: ToolCall[] = [];
  let tokensIn = 0;
  let tokensOut = 0;
  let modelCalls = 0;

  try {
    const loop = runToolLoop(
      {
        provider: deps.provider,
        model: deps.model,
        runners: deps.runners ?? [],
        priorCalls: 0,
        reserveCalls,
        // One usage event per model call, so a three-call answer is three
        // events and the spend cap sees the real total; only the first counts
        // toward `usage_daily.messages` so Overview still counts answers.
        onModelUsage: async (callTokensIn, callTokensOut, cost) => {
          const messageCount = modelCalls === 0 ? 1 : 0;
          modelCalls += 1;
          tokensIn += callTokensIn;
          tokensOut += callTokensOut;
          await recordMessageUsage(
            deps,
            input,
            clock(),
            callTokensIn,
            callTokensOut,
            cost,
            messageCount,
          );
        },
        now: deps.now,
      },
      request,
    );
    for (;;) {
      const step = await loop.next();
      if (step.done) {
        text = step.value.text;
        toolCalls = step.value.calls;
        pending = step.value.pending;
        break;
      }
      const event = step.value;
      if (event.kind === "text") {
        yield { type: "token", text: event.text };
      } else {
        // Detail the widget may show and a v1 widget ignores.
        yield {
          type: "tool",
          name: event.call.name,
          state: event.state,
          callId: event.call.callId,
          kind: event.source,
          ...(event.ok === undefined ? {} : { ok: event.ok }),
        };
      }
    }
  } catch (err) {
    if (err instanceof ProviderError) {
      yield { type: "error", message: "The assistant could not complete this response." };
      return;
    }
    throw err;
  }

  const cited = citableByUrl(chunks);
  const messageId = newId("msg");
  const citations = cited.map((c) => ({ url: c.url, title: c.title }));

  if (pending.length > 0) {
    // Stored as it stands so the follow-up request can continue it, and so the
    // per-conversation call cap counts what this pause already spent. The
    // widget may be a fresh instance on a new page by then: D1 is the only
    // state the two share.
    if (!input.preview) {
      await deps.tenant.messages.create({
        id: messageId,
        conversationId,
        role: "assistant",
        content: text,
        citations,
        toolCalls,
        tokensIn,
        tokensOut,
        // Not a gap: the answer is in progress, and Gaps is for questions the
        // assistant could not answer at all.
        answered: true,
        createdAt: clock(),
        replyTo: questionId,
      });
    }
    for (const call of pending) {
      yield {
        type: "action",
        callId: call.callId,
        name: call.name,
        // Already validated against the schema the page sent.
        input: call.input,
        confirm: confirmFor(call.name, input.pageActions),
      };
    }
    yield {
      type: "done",
      messageId,
      conversationId,
      awaitingActions: pending.map((call) => call.callId),
    };
    return;
  }

  // Citations after the text: the widget renders them under the answer, and
  // emitting them first would show links before there is anything to link to.
  for (const chunk of cited) {
    yield { type: "citation", url: chunk.url, title: chunk.title };
  }

  if (!input.preview) {
    await deps.tenant.messages.create({
      id: messageId,
      conversationId,
      role: "assistant",
      content: text,
      citations,
      // null when nothing was called, so Conversations can tell "no tools" from
      // "tools that returned nothing".
      toolCalls: toolCalls.length > 0 ? toolCalls : null,
      tokensIn,
      tokensOut,
      answered: true,
      createdAt: clock(),
      replyTo: questionId,
    });
  }

  yield { type: "done", messageId, conversationId };
}

const RESUME_NOT_FOUND_MESSAGE = "This answer can no longer be continued.";

/**
 * Continues a paused assistant reply once the widget posts back the results of
 * the page actions it ran.
 */
export async function* answerWithActionResults(
  deps: AnswerDeps,
  input: ResumeInput,
): AsyncIterable<ChatEvent> {
  const clock = deps.now ?? Date.now;
  const conversation = await deps.tenant.conversations.get(input.conversationId);
  if (
    conversation === null ||
    conversation.assistantId !== input.assistantId ||
    conversation.visitorId !== input.visitorId
  ) {
    yield { type: "error", message: RESUME_NOT_FOUND_MESSAGE };
    return;
  }

  const pendingReply = await deps.tenant.messages.getPendingReply(
    conversation.id,
    input.resumeMessageId,
  );
  if (pendingReply === null) {
    yield { type: "error", message: RESUME_NOT_FOUND_MESSAGE };
    return;
  }

  const allMessages = await deps.tenant.messages.list(conversation.id);
  const replyIndex = allMessages.findIndex((m) => m.id === pendingReply.id);
  let questionIndex = -1;
  if (pendingReply.replyTo !== null) {
    questionIndex = allMessages.findIndex(
      (m) => m.id === pendingReply.replyTo && m.role === "user",
    );
  } else {
    for (let i = replyIndex - 1; i >= 0; i--) {
      if (allMessages[i]?.role === "user") {
        questionIndex = i;
        break;
      }
    }
  }
  const questionMsg = questionIndex >= 0 ? allMessages[questionIndex] : undefined;
  if (!questionMsg) {
    yield { type: "error", message: RESUME_NOT_FOUND_MESSAGE };
    return;
  }

  const history: LlmMessage[] = allMessages
    .slice(0, questionIndex)
    .map((m) => ({ role: m.role, content: m.content }));

  const embedded = await deps.embedder.embed([questionMsg.content], (tokens) =>
    recordEmbeddingOnly(deps, input, clock(), embeddingCostMicros(tokens)),
  );
  const [vector] = embedded.vectors;
  if (!vector) {
    yield { type: "error", message: "The assistant could not complete this response." };
    return;
  }

  const hits = await deps.retriever.query({
    vector,
    orgId: input.orgId,
    assistantId: input.assistantId,
    topK: TOP_K,
  });
  const aboveFloor = hits.filter((hit) => hit.score >= SCORE_FLOOR);
  const chunks = await resolveChunks(deps.tenant, input.assistantId, aboveFloor);

  const request = buildPrompt({
    behaviour: input.behaviour,
    chunks,
    history,
    question: questionMsg.content,
  });

  const priorCalls = Array.isArray(pendingReply.toolCalls)
    ? (pendingReply.toolCalls as StoredToolCall[])
    : [];
  const resultsByCallId = new Map<string, ActionResult>();
  for (const r of input.actionResults) {
    if (!resultsByCallId.has(r.callId)) {
      resultsByCallId.set(r.callId, r);
    }
  }

  const pendingCalls: ToolCall[] = [];
  const llmResults: LlmToolResult[] = [];
  const resolvedPriorCalls: StoredToolCall[] = priorCalls.map((call) => {
    if (!call.pending) return call;
    pendingCalls.push({ callId: call.callId, name: call.name, input: call.input });
    const result = resultsByCallId.get(call.callId);
    const content = result
      ? result.ok
        ? (result.result ?? "")
        : (result.error ?? "The page could not complete that action.")
      : "The page did not return a result for this action.";
    const ok = result?.ok ?? false;
    llmResults.push({ callId: call.callId, content, isError: !ok });
    const { pending: _dropPending, ...rest } = call;
    return {
      ...rest,
      ok,
      resultBytes: encoder.encode(content).byteLength,
      resultPreview: content.slice(0, 200),
    };
  });

  const reserveCalls = (count: number) =>
    deps.tenant.conversations.reserveToolCalls(
      conversation.id,
      count,
      MAX_TOOL_CALLS_PER_CONVERSATION,
    );

  let text = pendingReply.content;
  let newCalls: StoredToolCall[] = [];
  let nextPending: ToolCall[] = [];
  let tokensIn = 0;
  let tokensOut = 0;

  try {
    const loop = resumeToolLoop(
      {
        provider: deps.provider,
        model: deps.model,
        runners: deps.runners ?? [],
        priorCalls: 0,
        reserveCalls,
        onModelUsage: async (callTokensIn, callTokensOut, cost) => {
          tokensIn += callTokensIn;
          tokensOut += callTokensOut;
          // The pause already counted this answer as 1 message; resuming
          // continues the same message, so `messages` stays 0.
          await recordMessageUsage(deps, input, clock(), callTokensIn, callTokensOut, cost, 0);
        },
        now: deps.now,
      },
      request,
      pendingReply.content,
      pendingCalls,
      llmResults,
    );
    for (;;) {
      const step = await loop.next();
      if (step.done) {
        text = step.value.text;
        newCalls = step.value.calls;
        nextPending = step.value.pending;
        break;
      }
      const event = step.value;
      if (event.kind === "text") {
        yield { type: "token", text: event.text };
      } else {
        yield {
          type: "tool",
          name: event.call.name,
          state: event.state,
          callId: event.call.callId,
          kind: event.source,
          ...(event.ok === undefined ? {} : { ok: event.ok }),
        };
      }
    }
  } catch (err) {
    if (err instanceof ProviderError) {
      yield { type: "error", message: "The assistant could not complete this response." };
      return;
    }
    throw err;
  }

  const mergedCalls = [...resolvedPriorCalls, ...newCalls];
  await deps.tenant.messages.completeReply(pendingReply.id, text, mergedCalls, tokensIn, tokensOut);

  if (nextPending.length > 0) {
    for (const call of nextPending) {
      yield {
        type: "action",
        callId: call.callId,
        name: call.name,
        input: call.input,
        confirm: confirmFor(call.name, input.pageActions),
      };
    }
    yield {
      type: "done",
      messageId: pendingReply.id,
      conversationId: conversation.id,
      awaitingActions: nextPending.map((call) => call.callId),
    };
    return;
  }

  for (const chunk of citableByUrl(chunks)) {
    yield { type: "citation", url: chunk.url, title: chunk.title };
  }

  yield { type: "done", messageId: pendingReply.id, conversationId: conversation.id };
}
