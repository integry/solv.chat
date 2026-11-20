import {
  type AnswerOutcome,
  isId,
  MAX_CONVERSATION_SEARCH_LENGTH,
  type ReviewFailure,
} from "@solvchat/core";
import {
  type PreviewTraceSource,
  reviewFailureOf,
  type StoredTrace,
  type TraceDropReason,
  type TracePart,
} from "../chat/trace.js";
import type {
  ConversationFilter,
  ConversationRow,
  ConversationSummaryRow,
} from "../db/conversations.js";
import type { FeedbackValue } from "../db/feedback.js";
import { type Citation, type MessageRole, normalizeQuestionText } from "../db/messages.js";
import type { Tenant } from "../db/tenant.js";
import { DAY_MS } from "../util/time.js";
import { BadRequest, NotFound } from "./errors.js";
import { MAX_QUESTION_KEY } from "./gaps.js";

export interface ConversationFeedback {
  id: string;
  value: FeedbackValue;
  note: string;
  createdAt: number;
}

export interface ConversationToolCall {
  callId: string;
  name: string;
  kind: "mcp" | "action";
  ok: boolean;
  pending?: boolean;
}

export interface ConversationTurn {
  id: string;
  role: MessageRole;
  content: string;
  citations: Citation[];
  /**
   * Whether the visitor saw `citations` under the reply. False when the
   * version had "Show sources in answers" off: the admin then shows them as
   * the content the answer used.
   */
  citationsShown: boolean;
  toolCalls: ConversationToolCall[] | null;
  answered: boolean;
  /** For a reply, what the answer review decided; null when it was not reviewed. */
  outcome: AnswerOutcome | null;
  createdAt: number;
  feedback: ConversationFeedback[];
  answerDocumentId: string | null;
  /** For a reply, the question it answered; null for questions and older rows. */
  replyTo: string | null;
}

function mapToolCalls(raw: unknown[] | null): ConversationToolCall[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: ConversationToolCall[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const obj = item as Record<string, unknown>;
    if (typeof obj.callId !== "string" || typeof obj.name !== "string") continue;
    out.push({
      callId: obj.callId,
      name: obj.name,
      kind: obj.kind === "action" ? "action" : "mcp",
      ok: obj.ok === true,
      ...(obj.pending === true ? { pending: true } : {}),
    });
  }
  return out.length > 0 ? out : null;
}

export interface ConversationsPage {
  conversations: ConversationSummaryRow[];
  total: number;
  limit: number;
  offset: number;
  /**
   * True when a search was asked for but messages written before the search
   * existed are still being prepared for it: nothing was searched, the list
   * is empty, and the same request should be sent again.
   */
  searchPending: boolean;
  /**
   * With `searchPending`: how many of this assistant's messages are still to
   * be prepared, so the admin can say how far along it is.
   */
  searchRemaining?: number;
}

export interface ConversationDetail {
  conversation: ConversationRow;
  turns: ConversationTurn[];
}

const FILTER_FLAGS = {
  unanswered: "unanswered",
  not_helpful: "notHelpful",
  used_tool: "usedTool",
  could_not_answer: "couldNotAnswer",
  asked_for_person: "wantsHuman",
  off_topic: "offTopic",
} as const;

/** Date presets the Conversations screen offers. */
export const CONVERSATION_DAY_OPTIONS = [1, 7, 30, 90] as const;

// Shared with the admin, which bounds the search it sends to it.
const MAX_SEARCH = MAX_CONVERSATION_SEARCH_LENGTH;

/**
 * Reads `?filter=unanswered,not_helpful,used_tool,could_not_answer,asked_for_person,off_topic`, `?days=1|7|30|90`,
 * `?q=text`, `?question=` (a grouped question, matched by its key, as
 * Reports and Overview count it) and `?topic=` (a topic id) from a list
 * request. `?askedFrom=` and `?askedTo=` (inclusive UTC days, `YYYY-MM-DD`)
 * narrow `question` or `topic` to asks
 * made in those days, the period a Reports count is for: a conversation
 * started long before can hold a question asked in it, so `days` (when a
 * conversation started) cannot stand in for it. Unknown values are refused
 * rather than ignored, so a typo does not silently show every conversation.
 */
export function readConversationFilter(url: URL, now: number = Date.now()): ConversationFilter {
  const filter: ConversationFilter = {};
  const errors: string[] = [];
  const rawFilter = url.searchParams.get("filter");
  if (rawFilter !== null && rawFilter.trim() !== "") {
    for (const part of rawFilter.split(",")) {
      const name = part.trim();
      // Own keys only: `constructor` or `__proto__` must be refused too.
      if (!Object.hasOwn(FILTER_FLAGS, name)) {
        errors.push(`filter: must be ${Object.keys(FILTER_FLAGS).join(", ")}`);
        break;
      }
      filter[FILTER_FLAGS[name as keyof typeof FILTER_FLAGS]] = true;
    }
  }
  const rawDays = url.searchParams.get("days");
  if (rawDays !== null && rawDays !== "") {
    const days = Number(rawDays);
    if (!(CONVERSATION_DAY_OPTIONS as readonly number[]).includes(days)) {
      errors.push(`days: must be ${CONVERSATION_DAY_OPTIONS.join(", ")}`);
    } else {
      filter.since = now - days * DAY_MS;
    }
  }
  const search = (url.searchParams.get("q") ?? "").trim();
  if (search.length > MAX_SEARCH) {
    errors.push(`q: must be at most ${MAX_SEARCH} characters`);
  } else if (search !== "") {
    filter.search = search;
  }
  const rawQuestion = url.searchParams.get("question");
  if (rawQuestion !== null && rawQuestion.trim() !== "") {
    // Normalised again, as a dismissal is, so the display text finds its group.
    const question = normalizeQuestionText(rawQuestion);
    if (question.length > MAX_QUESTION_KEY) {
      errors.push(`question: must be at most ${MAX_QUESTION_KEY} characters`);
    } else {
      filter.question = question;
    }
  }
  const rawTopic = url.searchParams.get("topic");
  if (rawTopic !== null && rawTopic !== "") {
    // An id, not a name: names change on rename, and a link must keep working.
    if (isId(rawTopic, "top")) {
      filter.topic = rawTopic;
    } else {
      errors.push("topic: must be a topic id");
    }
  }
  const askedFrom = readUtcDay(url, "askedFrom", errors);
  const askedTo = readUtcDay(url, "askedTo", errors);
  if (askedFrom !== undefined || askedTo !== undefined) {
    if (
      filter.question === undefined &&
      filter.topic === undefined &&
      !errors.some((e) => e.startsWith("question:") || e.startsWith("topic:"))
    ) {
      errors.push("askedFrom, askedTo: need a question or a topic");
    }
    if (askedFrom !== undefined && askedTo !== undefined && askedFrom > askedTo) {
      errors.push("askedFrom: must not be after askedTo");
    }
    if (askedFrom !== undefined) filter.askedFrom = askedFrom;
    // The whole of the last day, to its last millisecond, as Reports counts it.
    if (askedTo !== undefined) filter.askedTo = askedTo + DAY_MS - 1;
  }
  if (errors.length > 0) throw new BadRequest(errors);
  return filter;
}

const UTC_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A `YYYY-MM-DD` parameter as the millisecond its UTC day starts, or undefined when absent. */
function readUtcDay(url: URL, name: string, errors: string[]): number | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return undefined;
  const start = UTC_DAY.test(raw) ? Date.parse(`${raw}T00:00:00Z`) : Number.NaN;
  // A day that does not exist (2026-02-30) parses to another, so check it reads back.
  if (Number.isNaN(start) || new Date(start).toISOString().slice(0, 10) !== raw) {
    errors.push(`${name}: must be a day, YYYY-MM-DD`);
    return undefined;
  }
  return start;
}

/** Lists conversations for an assistant, newest first and paged. */
export async function listConversations(
  tenant: Tenant,
  assistantId: string,
  options: { limit?: number; offset?: number; filter?: ConversationFilter } = {},
): Promise<ConversationsPage> {
  const assistant = await tenant.assistants.get(assistantId);
  if (assistant === null) throw new NotFound("assistant");

  const limit = Math.min(Math.max(1, Math.trunc(options.limit ?? 25)), 100);
  const offset = Math.max(0, Math.trunc(options.offset ?? 0));
  const { conversations, total, searchPending, searchRemaining } =
    await tenant.conversations.listPaged(assistantId, {
      limit,
      offset,
      ...(options.filter ? { filter: options.filter } : {}),
    });

  return {
    conversations,
    total,
    limit,
    offset,
    searchPending,
    ...(searchRemaining === undefined ? {} : { searchRemaining }),
  };
}

/** Returns a single conversation with its turns, citations, feedback, and linked answers. */
export async function getConversation(
  tenant: Tenant,
  conversationId: string,
): Promise<ConversationDetail> {
  const conversation = await tenant.conversations.get(conversationId);
  if (conversation === null) throw new NotFound("conversation");

  const [messages, feedbackRows, gapAnswers] = await Promise.all([
    tenant.messages.list(conversationId),
    tenant.feedback.listForConversation(conversationId),
    tenant.messages.listGapAnswersForConversation(conversationId),
  ]);

  const feedbackByMessage = new Map<string, ConversationFeedback[]>();
  for (const fb of feedbackRows) {
    const list = feedbackByMessage.get(fb.messageId);
    const item: ConversationFeedback = {
      id: fb.id,
      value: fb.value,
      note: fb.note,
      createdAt: fb.createdAt,
    };
    if (list) {
      list.push(item);
    } else {
      feedbackByMessage.set(fb.messageId, [item]);
    }
  }

  const turns: ConversationTurn[] = messages.map((msg) => {
    // A reply shows the answer written for the question it records, not for
    // whichever question happens to precede it: two requests can interleave.
    const answerDocumentId =
      msg.role === "assistant"
        ? ((msg.replyTo !== null ? gapAnswers.get(msg.replyTo) : undefined) ??
          gapAnswers.get(msg.id) ??
          null)
        : (gapAnswers.get(msg.id) ?? null);
    return {
      id: msg.id,
      role: msg.role,
      content: msg.content,
      citations: msg.citations,
      citationsShown: msg.citationsShown,
      toolCalls: msg.role === "assistant" ? mapToolCalls(msg.toolCalls) : null,
      answered: msg.answered,
      outcome: msg.role === "assistant" ? msg.outcome : null,
      createdAt: msg.createdAt,
      feedback: feedbackByMessage.get(msg.id) ?? [],
      answerDocumentId,
      replyTo: msg.role === "assistant" ? msg.replyTo : null,
    };
  });

  return { conversation, turns };
}

/** The most of a chunk's current text the trace view shows. */
export const TRACE_EXCERPT_CHARS = 400;

/** A retrieval candidate with the content it points at, read now. */
export interface AnswerTraceCandidate {
  chunkId: string;
  score: number;
  used: boolean;
  dropped?: TraceDropReason;
  /** Null when the chunk is gone: its content has changed or been removed since. */
  content: {
    documentId: string;
    title: string;
    url: string;
    sourceKind: "push" | "sitemap" | "entry";
    headingPath: string;
    /** The chunk's current text, cut to `TRACE_EXCERPT_CHARS`. */
    excerpt: string;
  } | null;
}

export interface AnswerTracePartView {
  kind: TracePart["kind"];
  stop: TracePart["stop"];
  version: {
    id: string;
    /** What it was when it answered. */
    state: "published" | "draft";
    /** What it is now; null when the version no longer exists. */
    current: {
      state: "draft" | "published" | "archived";
      createdAt: number;
      publishedAt: number | null;
    } | null;
  };
  model: TracePart["model"];
  retrieval: {
    floor: number;
    ms: number;
    candidates: AnswerTraceCandidate[];
    /** Hits whose content was gone (the index had not caught up); null on older traces. */
    stale: number | null;
    /** Whether it searched again because of them; null on older traces. */
    searchedAgain: boolean | null;
  };
  timing: TracePart["timing"];
  tools: TracePart["tools"];
}

export interface AnswerTraceView {
  messageId: string;
  /**
   * Where the answer came from: a visitor reply, or one that stored no
   * message ("Try it", a test run), marked as such.
   */
  source: "visitor" | PreviewTraceSource;
  tokensIn: number;
  tokensOut: number;
  costMicros: number | null;
  firstTokenMs: number | null;
  totalMs: number | null;
  /** Null for an answer written before traces existed, or whose trace could not be written. */
  trace: { parts: AnswerTracePartView[]; truncated: boolean } | null;
  /**
   * Why the answer check gave no result, as a fixed code (never the
   * provider's text or the visitor's), or null when it did, is running or
   * has not run. `review_error` too for a catch-up that was cut off.
   */
  reviewFailure: ReviewFailure | null;
}

/**
 * How one assistant answer was made. The stored trace holds ids only; the
 * content they name is read now, so the view shows what that content says
 * today, and says so when it is gone. The message must be an assistant
 * reply in this conversation (and, through the tenant, in this org).
 */
export async function getAnswerTrace(
  tenant: Tenant,
  conversationId: string,
  messageId: string,
  now: number = Date.now(),
): Promise<AnswerTraceView> {
  const [conversation, message] = await Promise.all([
    tenant.conversations.get(conversationId),
    tenant.messages.get(messageId),
  ]);
  if (
    conversation === null ||
    message === null ||
    message.conversationId !== conversation.id ||
    message.role !== "assistant"
  ) {
    throw new NotFound("message");
  }

  const stored = await tenant.traces.get(message.id);
  return {
    messageId: message.id,
    source: "visitor",
    tokensIn: message.tokensIn,
    tokensOut: message.tokensOut,
    costMicros: message.costMicros,
    firstTokenMs: message.firstTokenMs,
    totalMs: message.totalMs,
    trace: await traceView(tenant, conversation.assistantId, stored),
    // A catch-up claim its run never finished says `review_error` too.
    reviewFailure: reviewFailureOf(stored?.review, message.outcome, now),
  };
}

/**
 * How one "Try it" answer or answer-test answer was made: the trace the
 * preview kept in `preview_traces`, for this assistant (and, through the
 * tenant, this org). A visitor reply's id is never found here.
 */
export async function getPreviewTrace(
  tenant: Tenant,
  assistantId: string,
  traceId: string,
): Promise<AnswerTraceView> {
  const row = await tenant.previewTraces.get(assistantId, traceId);
  if (row === null) throw new NotFound("trace");
  const answer = row.trace?.parts[0];
  return {
    messageId: row.id,
    source: row.source,
    tokensIn: row.tokensIn,
    tokensOut: row.tokensOut,
    costMicros: row.costMicros,
    firstTokenMs: answer?.timing.firstTokenMs ?? null,
    totalMs: answer?.timing.totalMs ?? null,
    trace: await traceView(tenant, assistantId, row.trace),
    // "Try it" and test runs are never reviewed.
    reviewFailure: null,
  };
}

/**
 * A stored trace with the content it names read now: the view shows what
 * that content says today, and says so when it is gone.
 */
async function traceView(
  tenant: Tenant,
  assistantId: string,
  stored: StoredTrace | null,
): Promise<AnswerTraceView["trace"]> {
  // A trace with only the review's note (the answer's own write failed) has
  // no details of how the answer was made.
  if (stored === null || stored.parts.length === 0) return null;
  const chunkIds = [
    ...new Set(stored.parts.flatMap((p) => p.retrieval.candidates.map((c) => c.chunkId))),
  ];
  const versionIds = [...new Set(stored.parts.map((p) => p.version.id))];
  const [chunks, versions] = await Promise.all([
    // At most 98 ids per read (D1's 100 bound parameters, two for org and assistant).
    Promise.all(
      Array.from({ length: Math.ceil(chunkIds.length / 98) }, (_, i) =>
        tenant.documents.chunksByIds(assistantId, chunkIds.slice(i * 98, (i + 1) * 98)),
      ),
    ).then((groups) => groups.flat()),
    Promise.all(versionIds.map((id) => tenant.versions.byId(assistantId, id))),
  ]);
  const chunkById = new Map(chunks.map((c) => [c.id, c]));
  const versionById = new Map(versions.flatMap((v) => (v === null ? [] : [[v.id, v] as const])));

  const parts = stored.parts.map((part): AnswerTracePartView => {
    const version = versionById.get(part.version.id);
    return {
      kind: part.kind,
      stop: part.stop,
      version: {
        id: part.version.id,
        state: part.version.state,
        current: version
          ? { state: version.state, createdAt: version.createdAt, publishedAt: version.publishedAt }
          : null,
      },
      model: part.model,
      retrieval: {
        floor: part.retrieval.floor,
        ms: part.retrieval.ms,
        stale: typeof part.retrieval.stale === "number" ? part.retrieval.stale : null,
        searchedAgain:
          typeof part.retrieval.searchedAgain === "boolean" ? part.retrieval.searchedAgain : null,
        candidates: part.retrieval.candidates.map((candidate): AnswerTraceCandidate => {
          const chunk = chunkById.get(candidate.chunkId);
          return {
            chunkId: candidate.chunkId,
            score: candidate.score,
            used: candidate.used,
            ...(candidate.dropped ? { dropped: candidate.dropped } : {}),
            content: chunk
              ? {
                  documentId: chunk.documentId,
                  title: chunk.title,
                  url: chunk.url,
                  sourceKind: chunk.sourceKind,
                  headingPath: chunk.headingPath,
                  excerpt: chunk.text.slice(0, TRACE_EXCERPT_CHARS),
                }
              : null,
          };
        }),
      },
      timing: part.timing,
      tools: part.tools,
    };
  });

  return { parts, truncated: stored.truncated === true };
}
