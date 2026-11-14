import type { ConversationRow, ConversationSummaryRow } from "../db/conversations.js";
import type { FeedbackValue } from "../db/feedback.js";
import type { Citation, MessageRole } from "../db/messages.js";
import type { Tenant } from "../db/tenant.js";
import { NotFound } from "./errors.js";

export interface ConversationFeedback {
  id: string;
  value: FeedbackValue;
  note: string;
  createdAt: number;
}

export interface ConversationTurn {
  id: string;
  role: MessageRole;
  content: string;
  citations: Citation[];
  answered: boolean;
  createdAt: number;
  feedback: ConversationFeedback[];
  answerDocumentId: string | null;
}

export interface ConversationsPage {
  conversations: ConversationSummaryRow[];
  total: number;
  limit: number;
  offset: number;
}

export interface ConversationDetail {
  conversation: ConversationRow;
  turns: ConversationTurn[];
}

/** Lists conversations for an assistant, newest first and paged. */
export async function listConversations(
  tenant: Tenant,
  assistantId: string,
  options: { limit?: number; offset?: number } = {},
): Promise<ConversationsPage> {
  const assistant = await tenant.assistants.get(assistantId);
  if (assistant === null) throw new NotFound("assistant");

  const limit = Math.min(Math.max(1, Math.trunc(options.limit ?? 25)), 100);
  const offset = Math.max(0, Math.trunc(options.offset ?? 0));
  const { conversations, total } = await tenant.conversations.listPaged(assistantId, {
    limit,
    offset,
  });

  return { conversations, total, limit, offset };
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

  const turns: ConversationTurn[] = messages.map((msg) => ({
    id: msg.id,
    role: msg.role,
    content: msg.content,
    citations: msg.citations,
    answered: msg.answered,
    createdAt: msg.createdAt,
    feedback: feedbackByMessage.get(msg.id) ?? [],
    answerDocumentId: gapAnswers.get(msg.id) ?? null,
  }));

  return { conversation, turns };
}
