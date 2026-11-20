import {
  type ActionResult,
  type BehaviourConfig,
  type ChatEvent,
  newId,
  type PageAction,
} from "@solvchat/core";
import type { Citation } from "../db/messages.js";
import type { Tenant } from "../db/tenant.js";
import { type ResolvedChunk, resolveChunks } from "../ingest/resolve.js";
import type { ModelInfo } from "../models.js";
import { ProviderError } from "../providers/error.js";
import { type Embedder, embeddingCostMicros, type Retriever } from "../providers/retrieval.js";
import type { LlmMessage, LlmProvider, LlmToolResult, ToolCall } from "../providers/types.js";
import type { UsageSink } from "../seams/types.js";
import { buildPrompt, MAX_TURNS } from "./prompt.js";
import type { ReviewJob } from "./review.js";
import { DEFAULT_SCORE_FLOOR, selectCandidates } from "./scoreFloor.js";
import {
  MAX_TOOL_CALLS_PER_CONVERSATION,
  resumeToolLoop,
  runToolLoop,
  type StoredToolCall,
  type ToolLoopContinuation,
  type ToolRunner,
} from "./toolLoop.js";
import {
  type AnswerRecorder,
  answerRecorder,
  type KeySource,
  MAX_TRACE_CANDIDATES,
  type PreviewTraceSource,
  type TraceCandidate,
  type TracePart,
  type TraceStop,
  traceCandidates,
} from "./trace.js";

// A chunk below the floor is noise; including it would make the model answer
// from unrelated pages, which is worse than admitting the gap. The spec says
// "above a score floor" and stops; the default and why it is 0.2 are in
// `scoreFloor.ts`. An instance may override it with `SOLV_SCORE_FLOOR`.
export const SCORE_FLOOR = DEFAULT_SCORE_FLOOR;
export const TOP_K = 6;
/**
 * How many hits the retriever is asked for, of which at most `TOP_K` reach
 * the model. More than `TOP_K`, so that setting aside duplicates and a
 * document's extra chunks (see `selectCandidates`) still leaves enough, and
 * so a written answer below six page chunks is among the hits at all.
 * Vectorize returns up to 100 matches when no values or metadata are asked
 * for, as here ("Maximum returned results (topK) without values and
 * metadata: 100").
 * Source: https://developers.cloudflare.com/vectorize/platform/limits/ — checked 2026-11-20
 * Every hit is resolved in one D1 query and kept in the trace, whose ceiling
 * is the same number.
 */
export const CANDIDATE_POOL = MAX_TRACE_CANDIDATES;
/** Lease duration for an active resume claim before a stalled worker's lock expires. */
export const RESUME_CLAIM_TTL_MS = 60_000;
const RESUME_CLAIM_RENEW_INTERVAL_MS = Math.floor(RESUME_CLAIM_TTL_MS / 4);

export interface AnswerDeps {
  tenant: Tenant;
  embedder: Embedder;
  retriever: Retriever;
  provider: LlmProvider;
  model?: ModelInfo | undefined;
  usage: UsageSink;
  /**
   * The retrieval score floor this instance uses (`SOLV_SCORE_FLOOR`, read by
   * `scoreFloorFrom`). Absent, the default `SCORE_FLOOR`.
   */
  scoreFloor?: number | undefined;
  now?: (() => number) | undefined;
  signal?: AbortSignal | undefined;
  /**
   * Tool sources for this answer. Empty (the default) reproduces phase 1
   * exactly: no `tools` key on the request, one model call.
   */
  runners?: readonly ToolRunner[] | undefined;
  /**
   * What the answer's trace needs that the answer path does not know: the
   * version that answered and where the model key came from. Absent, no
   * trace is written. A preview ("Try it", a test run) stores no message, so
   * its trace is written only when `trace.preview` says where it goes.
   */
  trace?: AnswerTraceContext | undefined;
  /**
   * Answer review. Absent, nothing is reviewed or stored: this is a preview
   * or a test run. (With "Review answers" off the hook is still given: it
   * stores `declined` on a retrieval miss and reviews nothing.) `schedule` must not wait for the review:
   * it is handed each completed visitor reply after its `done` event and
   * trace, and runs as deferred work that cannot reach the visitor.
   */
  review?: AnswerReviewHook | undefined;
}

export interface AnswerReviewHook {
  schedule(job: ReviewJob): void;
}

export interface AnswerTraceContext {
  version: { id: string; state: "published" | "draft" };
  /**
   * Where the model key came from. A function is called only when a model
   * was asked, from the trace write after `done`, so the visitor never waits
   * on the read it may take.
   */
  keySource: KeySource | (() => Promise<KeySource>);
  /**
   * For an answer that stores no message: where it came from, and for a test
   * run which run and test, so its trace is kept apart from visitor replies
   * (`preview_traces`). Required for a preview to have a trace at all.
   */
  preview?: PreviewTraceTarget | undefined;
}

export interface PreviewTraceTarget {
  source: PreviewTraceSource;
  runId?: string | undefined;
  testId?: string | undefined;
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

/**
 * The documents an answer was given to answer from, every kind included
 * (written answers too), for the Reports usage lists. Internal: stored apart
 * from the citations and never sent to the visitor.
 */
function usedDocumentIds(chunks: readonly ResolvedChunk[]): string[] {
  return [...new Set(chunks.map((chunk) => chunk.documentId))];
}

/**
 * Combines pre-pause citations with newly retrieved citations, deduplicating by
 * URL so the completed answer retains attribution for text generated before and
 * after each pause.
 */
function mergeCitations(existing: readonly Citation[], added: readonly Citation[]): Citation[] {
  const seen = new Set<string>();
  const out: Citation[] = [];
  for (const citation of existing) {
    if (seen.has(citation.url)) continue;
    seen.add(citation.url);
    out.push({ url: citation.url, title: citation.title });
  }
  for (const citation of added) {
    if (seen.has(citation.url)) continue;
    seen.add(citation.url);
    out.push({ url: citation.url, title: citation.title });
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
  cost: number | null,
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
    costMicros: cost ?? 0,
    ...(cost === null ? { costUnknown: true } : {}),
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

interface TraceFacts {
  kind: TracePart["kind"];
  candidates: TraceCandidate[];
  timing: ReturnType<AnswerRecorder["snapshot"]>;
  modelCalled: boolean;
  stop: TraceStop;
}

/** Which reply a trace belongs to, and what a preview's trace must keep itself. */
interface TraceTarget {
  messageId: string;
  assistantId: string;
  /** True for "Try it" and test runs: no message row exists. */
  preview: boolean;
  /** A preview's tokens and cost: there is no message row to read them from. */
  tokensIn?: number;
  tokensOut?: number;
  costMicros?: number | null;
}

async function tracePartFor(
  context: AnswerTraceContext,
  provider: LlmProvider,
  floor: number,
  facts: TraceFacts,
): Promise<TracePart> {
  const keySource = facts.modelCalled
    ? typeof context.keySource === "function"
      ? await context.keySource()
      : context.keySource
    : null;
  return {
    kind: facts.kind,
    version: { ...context.version },
    model: keySource === null ? null : { provider: provider.name, id: provider.model, keySource },
    retrieval: { floor, ms: facts.timing.retrievalMs, candidates: facts.candidates },
    timing: { firstTokenMs: facts.timing.firstTokenMs, totalMs: facts.timing.totalMs },
    tools: { rounds: facts.timing.toolRounds, ms: facts.timing.toolMs },
    stop: facts.stop,
  };
}

/**
 * Writes a reply's trace once it is complete and sent: on the stored message
 * for a visitor, in `preview_traces`, marked with where it came from, for
 * "Try it" and a test run. The key source is read here too, after `done`.
 * A failure is logged (its message only: a trace holds ids and numbers, and
 * the error names no request data) and swallowed: the reply is already sent.
 */
async function saveTrace(
  deps: AnswerDeps,
  target: TraceTarget,
  facts: TraceFacts,
  clock: () => number,
): Promise<void> {
  const context = deps.trace;
  if (!context) return;
  // A preview without a target has nowhere to keep it; a visitor reply never has one.
  if (target.preview !== (context.preview !== undefined)) return;
  try {
    const part = await tracePartFor(context, deps.provider, floorFor(deps), facts);
    if (context.preview !== undefined) {
      await deps.tenant.previewTraces.put({
        id: target.messageId,
        assistantId: target.assistantId,
        source: context.preview.source,
        runId: context.preview.runId,
        testId: context.preview.testId,
        tokensIn: target.tokensIn ?? 0,
        tokensOut: target.tokensOut ?? 0,
        costMicros: target.costMicros ?? null,
        part,
        createdAt: clock(),
      });
    } else if (part.kind === "answer") {
      await deps.tenant.traces.put(target.messageId, part, clock());
    } else {
      await deps.tenant.traces.append(target.messageId, part, clock());
    }
  } catch (err) {
    console.error("chat: trace write failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Hands a stored, completed reply to the answer review. Scheduling only:
 * the review runs as deferred work and nothing it does reaches this answer.
 */
function scheduleReview(deps: AnswerDeps, job: ReviewJob): void {
  if (!deps.review) return;
  try {
    deps.review.schedule(job);
  } catch (err) {
    console.error("chat: answer review not scheduled", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** The floor this answer uses: the instance's, or the default. */
function floorFor(deps: Pick<AnswerDeps, "scoreFloor">): number {
  return deps.scoreFloor ?? SCORE_FLOOR;
}

/**
 * The resolved chunks that reach the model (see `selectChunks`) and every
 * hit as a trace candidate, both against the floor this answer uses.
 */
function keptChunks(
  deps: Pick<AnswerDeps, "scoreFloor">,
  hits: readonly { chunkId: string; score: number }[],
  resolved: ResolvedChunk[],
): { chunks: ResolvedChunk[]; candidates: TraceCandidate[] } {
  const floor = floorFor(deps);
  const { chunks, dropped } = selectCandidates(resolved, floor, { topK: TOP_K });
  return {
    chunks,
    candidates: traceCandidates(
      hits,
      floor,
      resolved,
      new Set(chunks.map((c) => c.chunkId)),
      dropped,
    ),
  };
}

function stopFor(stopReason: string | undefined): TraceStop {
  return stopReason === "length" ? "length" : "complete";
}

/**
 * Embeds the question, queries the retriever and resolves the hits through
 * D1, timed as one retrieval step. Every hit is resolved, those under the
 * floor too, so the trace can name their documents; only the chunks at or
 * above the floor (and, within a small margin under it, more chunks of a
 * document already kept) reach the model.
 */
async function retrieve(
  deps: AnswerDeps,
  input: Pick<AnswerInput, "orgId" | "assistantId">,
  question: string,
  recorder: AnswerRecorder,
  clock: () => number,
): Promise<{ chunks: ResolvedChunk[]; candidates: TraceCandidate[] } | null> {
  return recorder.retrieval(async () => {
    // The question's embedding is billed whatever happens next — a failing
    // retriever, D1 read or model call must not make it vanish — so it is
    // recorded the moment the provider reports it, as spend that is not a
    // message. The answer's own usage event carries model tokens only.
    const embedded = await deps.embedder.embed(
      [question],
      (tokens) => recordEmbeddingOnly(deps, input, clock(), embeddingCostMicros(tokens)),
      deps.signal ? { signal: deps.signal } : undefined,
    );
    const [vector] = embedded.vectors;
    if (!vector) return null;
    const hits = await deps.retriever.query({
      vector,
      orgId: input.orgId,
      assistantId: input.assistantId,
      topK: CANDIDATE_POOL,
      ...(deps.signal ? { signal: deps.signal } : {}),
    });
    const resolved = await resolveChunks(deps.tenant, input.assistantId, hits);
    return keptChunks(deps, hits, resolved);
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
  const recorder = answerRecorder(clock);
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

  const retrieved = await retrieve(deps, input, input.message, recorder, clock);
  if (retrieved === null) {
    yield { type: "error", message: "The assistant could not complete this response." };
    return;
  }
  const { chunks, candidates } = retrieved;

  if (chunks.length === 0) {
    // No model call at all: there is nothing to answer from, so spending a
    // request to have the model say so is waste — and it might answer anyway
    // from its own training.
    recorder.firstToken();
    yield { type: "token", text: input.behaviour.fallbackText };
    // Counted before the reply is stored, as on the model path below: the
    // visitor has already been answered, so a failing write must not erase it.
    await recordMessageUsage(deps, input, clock(), 0, 0, 0);
    const messageId = newId("msg");
    const timing = recorder.snapshot();
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
        costMicros: 0,
        answered: false,
        createdAt: clock(),
        replyTo: questionId,
        firstTokenMs: timing.firstTokenMs,
        totalMs: timing.totalMs,
      });
    }
    yield { type: "done", messageId, conversationId };
    await saveTrace(
      deps,
      { messageId, assistantId: input.assistantId, preview: input.preview === true },
      { kind: "answer", candidates, timing, modelCalled: false, stop: "complete" },
      clock,
    );
    if (!input.preview) {
      scheduleReview(deps, {
        orgId: input.orgId,
        assistantId: input.assistantId,
        messageId,
        questionId,
        question: input.message,
        reply: input.behaviour.fallbackText,
        retrievalMiss: true,
      });
    }
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
  let continuation: ToolLoopContinuation | undefined;
  let stopReason: string | undefined;
  let tokensIn = 0;
  let tokensOut = 0;
  let modelCalls = 0;
  // The stored reply's cost: the sum over its model calls, or null once any
  // call's cost is unknown.
  let messageCost: number | null = 0;

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
          messageCost = messageCost === null || cost === null ? null : messageCost + cost;
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
        onToolRound: (ms) => recorder.toolRound(ms),
        signal: deps.signal,
        now: deps.now,
        // A preview's conversation id is made up for this request and names
        // no stored row, so it is not passed on to a tool server.
        ...(input.preview ? {} : { callContext: { conversationId, visitorId: input.visitorId } }),
      },
      request,
    );
    for (;;) {
      const step = await loop.next();
      if (step.done) {
        text = step.value.text;
        toolCalls = step.value.calls;
        pending = step.value.pending;
        continuation = step.value.continuation;
        stopReason = step.value.stopReason;
        break;
      }
      const event = step.value;
      if (event.kind === "text") {
        recorder.firstToken();
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
  const documentIds = usedDocumentIds(chunks);
  const timing = recorder.snapshot();

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
        costMicros: messageCost,
        // Not a gap: the answer is in progress, and Gaps is for questions the
        // assistant could not answer at all.
        answered: true,
        createdAt: clock(),
        replyTo: questionId,
        resumeContext: continuation ?? null,
        firstTokenMs: timing.firstTokenMs,
        totalMs: timing.totalMs,
        documentIds,
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
    await saveTrace(
      deps,
      {
        messageId,
        assistantId: input.assistantId,
        preview: input.preview === true,
        tokensIn,
        tokensOut,
        costMicros: messageCost,
      },
      { kind: "answer", candidates, timing, modelCalled: true, stop: "paused" },
      clock,
    );
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
      costMicros: messageCost,
      answered: true,
      createdAt: clock(),
      replyTo: questionId,
      firstTokenMs: timing.firstTokenMs,
      totalMs: timing.totalMs,
      documentIds,
    });
  }

  yield { type: "done", messageId, conversationId };
  // After `done`, in the pipeline that persisted the message: the visitor has
  // the whole answer before this write starts, and its failure is swallowed.
  await saveTrace(
    deps,
    {
      messageId,
      assistantId: input.assistantId,
      preview: input.preview === true,
      tokensIn,
      tokensOut,
      costMicros: messageCost,
    },
    { kind: "answer", candidates, timing, modelCalled: true, stop: stopFor(stopReason) },
    clock,
  );
  if (!input.preview) {
    scheduleReview(deps, {
      orgId: input.orgId,
      assistantId: input.assistantId,
      messageId,
      questionId,
      question: input.message,
      reply: text,
      retrievalMiss: false,
    });
  }
}

const RESUME_NOT_FOUND_MESSAGE = "This answer can no longer be continued.";

function parseContinuation(raw: unknown): ToolLoopContinuation | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.messages)) return undefined;
  if (typeof obj.pendingTurn !== "object" || obj.pendingTurn === null) return undefined;
  const pt = obj.pendingTurn as Record<string, unknown>;
  if (
    typeof pt.assistantText !== "string" ||
    !Array.isArray(pt.asked) ||
    !Array.isArray(pt.completedResults)
  ) {
    return undefined;
  }
  return {
    messages: obj.messages as LlmMessage[],
    pendingTurn: {
      assistantText: pt.assistantText,
      asked: pt.asked as ToolCall[],
      completedResults: pt.completedResults as LlmToolResult[],
    },
  };
}

/**
 * Continues a paused assistant reply once the widget posts back the results of
 * the page actions it ran.
 */
export async function* answerWithActionResults(
  deps: AnswerDeps,
  input: ResumeInput,
): AsyncIterable<ChatEvent> {
  const clock = deps.now ?? Date.now;
  const recorder = answerRecorder(clock);
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

  const priorCalls = Array.isArray(pendingReply.toolCalls)
    ? (pendingReply.toolCalls as StoredToolCall[])
    : [];
  const pendingCalls: ToolCall[] = [];
  const pendingIds = new Set<string>();
  for (const call of priorCalls) {
    if (call.pending) {
      pendingCalls.push({ callId: call.callId, name: call.name, input: call.input });
      pendingIds.add(call.callId);
    }
  }

  // Validate the submitted batch against the current pending batch before
  // claiming, embedding, or calling the model: reject stale, unrelated,
  // duplicate, or incomplete submissions without consuming pending calls.
  const resultsByCallId = new Map<string, ActionResult>();
  for (const r of input.actionResults) {
    if (resultsByCallId.has(r.callId) || !pendingIds.has(r.callId)) {
      yield { type: "error", message: RESUME_NOT_FOUND_MESSAGE };
      return;
    }
    resultsByCallId.set(r.callId, r);
  }
  if (pendingIds.size === 0 || resultsByCallId.size !== pendingIds.size) {
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

  // Atomically claim this pending revision so concurrent resumes cannot
  // independently generate continuations or overwrite each other's writes.
  const claimToken = crypto.randomUUID();
  const claimed = await deps.tenant.messages.claimPendingReply({
    conversationId: conversation.id,
    id: pendingReply.id,
    claimToken,
    revision: pendingReply.resumeRevision,
    now: clock(),
    ttlMs: RESUME_CLAIM_TTL_MS,
  });
  if (!claimed) {
    yield { type: "error", message: RESUME_NOT_FOUND_MESSAGE };
    return;
  }

  let completed = false;
  let leaseLost = false;
  let lastRenewedAt: number | null = null;
  // Keep only the throttled checkpoint check (removing the background
  // setInterval heartbeat) so there is a single renewal mechanism: the engine
  // already checks at natural checkpoints (post-embed, model/tool steps, and
  // streamed chunks), throttling D1 writes to once per interval while always
  // forcing a real awaited renewal immediately before persisting.
  const ensureLease = async (force = false): Promise<boolean> => {
    if (leaseLost) return false;
    const now = clock();
    if (!force && lastRenewedAt !== null && now - lastRenewedAt < RESUME_CLAIM_RENEW_INTERVAL_MS) {
      return true;
    }
    const ok = await deps.tenant.messages.renewReplyClaim({
      conversationId: conversation.id,
      id: pendingReply.id,
      claimToken,
      revision: pendingReply.resumeRevision,
      now,
      ttlMs: RESUME_CLAIM_TTL_MS,
    });
    if (!ok) {
      leaseLost = true;
    } else {
      lastRenewedAt = now;
    }
    return ok;
  };

  try {
    const history: LlmMessage[] = allMessages
      .slice(0, questionIndex)
      .map((m) => ({ role: m.role, content: m.content }));

    // Embedding spend is incurred once the provider reports it, even if the
    // resume lease is lost before the callback runs; the checkpoint right
    // below still fences retrieval, model calls, output, and reply persistence.
    const embedded = await recorder.retrieval(() =>
      deps.embedder.embed([questionMsg.content], (tokens) =>
        recordEmbeddingOnly(deps, input, clock(), embeddingCostMicros(tokens)),
      ),
    );
    if (!(await ensureLease())) {
      yield { type: "error", message: RESUME_NOT_FOUND_MESSAGE };
      return;
    }
    const [vector] = embedded.vectors;
    if (!vector) {
      yield { type: "error", message: "The assistant could not complete this response." };
      return;
    }

    const { chunks, candidates } = await recorder.retrieval(async () => {
      const hits = await deps.retriever.query({
        vector,
        orgId: input.orgId,
        assistantId: input.assistantId,
        topK: CANDIDATE_POOL,
      });
      const resolved = await resolveChunks(deps.tenant, input.assistantId, hits);
      return keptChunks(deps, hits, resolved);
    });

    const request = buildPrompt({
      behaviour: input.behaviour,
      chunks,
      history,
      question: questionMsg.content,
    });

    const llmResults: LlmToolResult[] = [];
    const resolvedPriorCalls: StoredToolCall[] = priorCalls.map((call) => {
      if (!call.pending) return call;
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
    let nextContinuation: ToolLoopContinuation | undefined;
    let tokensIn = 0;
    let tokensOut = 0;
    let resumeCost: number | null = 0;
    let stopReason: string | undefined;

    let abortedByLease = false;

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
            resumeCost = resumeCost === null || cost === null ? null : resumeCost + cost;
            // The pause already counted this answer as 1 message; resuming
            // continues the same message, so `messages` stays 0.
            await recordMessageUsage(deps, input, clock(), callTokensIn, callTokensOut, cost, 0);
          },
          ensureLease: () => ensureLease(),
          onToolRound: (ms) => recorder.toolRound(ms),
          now: deps.now,
          callContext: { conversationId: conversation.id, visitorId: conversation.visitorId },
        },
        request,
        pendingReply.content,
        pendingCalls,
        llmResults,
        parseContinuation(pendingReply.resumeContext),
      );
      for (;;) {
        const step = await loop.next();
        if (step.done) {
          text = step.value.text;
          newCalls = step.value.calls;
          nextPending = step.value.pending;
          nextContinuation = step.value.continuation;
          abortedByLease = step.value.abortedByLease ?? false;
          stopReason = step.value.stopReason;
          break;
        }
        const event = step.value;
        if (event.kind === "text") {
          recorder.firstToken();
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
        // The paused reply is still stored, so the failed continuation is
        // recorded on it: this is the one stored answer an error can explain.
        await saveTrace(
          deps,
          { messageId: pendingReply.id, assistantId: input.assistantId, preview: false },
          {
            kind: "resume",
            candidates,
            timing: recorder.snapshot(),
            modelCalled: true,
            stop: "error",
          },
          clock,
        );
        return;
      }
      throw err;
    }

    if (abortedByLease) {
      yield { type: "error", message: RESUME_NOT_FOUND_MESSAGE };
      return;
    }

    const resumedCitations = citableByUrl(chunks).map((c) => ({ url: c.url, title: c.title }));
    // Retain citations that supported text generated before the pause alongside
    // newly retrieved sources so the combined answer stays consistently attributed.
    const citations = mergeCitations(pendingReply.citations, resumedCitations);

    const mergedCalls = [...resolvedPriorCalls, ...newCalls];
    const timing = recorder.snapshot();
    if (!(await ensureLease(true))) {
      yield { type: "error", message: RESUME_NOT_FOUND_MESSAGE };
      return;
    }
    const saved = await deps.tenant.messages.completeReply({
      id: pendingReply.id,
      claimToken,
      revision: pendingReply.resumeRevision,
      content: text,
      citations,
      toolCalls: mergedCalls,
      resumeContext: nextPending.length > 0 ? (nextContinuation ?? null) : null,
      tokensIn,
      tokensOut,
      costMicros: resumeCost,
      documentIds: usedDocumentIds(chunks),
      now: clock(),
    });
    if (!saved) {
      yield { type: "error", message: RESUME_NOT_FOUND_MESSAGE };
      return;
    }
    completed = true;

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
      await saveTrace(
        deps,
        { messageId: pendingReply.id, assistantId: input.assistantId, preview: false },
        { kind: "resume", candidates, timing, modelCalled: true, stop: "paused" },
        clock,
      );
      return;
    }

    for (const citation of citations) {
      yield { type: "citation", url: citation.url, title: citation.title };
    }

    yield { type: "done", messageId: pendingReply.id, conversationId: conversation.id };
    await saveTrace(
      deps,
      { messageId: pendingReply.id, assistantId: input.assistantId, preview: false },
      { kind: "resume", candidates, timing, modelCalled: true, stop: stopFor(stopReason) },
      clock,
    );
    // Reviewed once complete, never while paused: a paused reply is not the
    // answer yet.
    scheduleReview(deps, {
      orgId: input.orgId,
      assistantId: input.assistantId,
      messageId: pendingReply.id,
      questionId: questionMsg.id,
      question: questionMsg.content,
      reply: text,
      retrievalMiss: false,
    });
  } finally {
    if (!completed) {
      try {
        await deps.tenant.messages.releaseReplyClaim(pendingReply.id, claimToken);
      } catch {
        // Best-effort cleanup; expired claims also recover after RESUME_CLAIM_TTL_MS.
      }
    }
  }
}
