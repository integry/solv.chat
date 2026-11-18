import { MAX_CONVERSATION_SEARCH_LENGTH } from "@solvchat/core";
import type {
  ConversationFilter,
  ConversationRow,
  ConversationSummaryRow,
} from "../db/conversations.js";
import type { FeedbackValue } from "../db/feedback.js";
import type { Citation, MessageRole } from "../db/messages.js";
import type { Tenant } from "../db/tenant.js";
import { BadRequest, NotFound } from "./errors.js";

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
  toolCalls: ConversationToolCall[] | null;
  answered: boolean;
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
} as const;

/** Date presets the Conversations screen offers. */
export const CONVERSATION_DAY_OPTIONS = [1, 7, 30, 90] as const;

const DAY_MS = 86_400_000;
// Shared with the admin, whose question links bound their search to it.
const MAX_SEARCH = MAX_CONVERSATION_SEARCH_LENGTH;

/**
 * Reads `?filter=unanswered,not_helpful,used_tool`, `?days=1|7|30|90` and
 * `?q=text` from a list request. Unknown values are refused rather than
 * ignored, so a typo does not silently show every conversation.
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
  if (errors.length > 0) throw new BadRequest(errors);
  return filter;
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
      toolCalls: msg.role === "assistant" ? mapToolCalls(msg.toolCalls) : null,
      answered: msg.answered,
      createdAt: msg.createdAt,
      feedback: feedbackByMessage.get(msg.id) ?? [],
      answerDocumentId,
      replyTo: msg.role === "assistant" ? msg.replyTo : null,
    };
  });

  return { conversation, turns };
}
